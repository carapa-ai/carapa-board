import { KnowledgeInsertButton } from './knowledge-source';
import {
  KNOWLEDGE_DRAG_TYPE,
  parseKnowledgeReference,
  knowledgeReferenceMarkdown,
} from '@/lib/knowledge-reference';
import { isKnowledgeFileContentUrl } from '@/lib/knowledge-files';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import {
  Columns2,
  Download,
  Eye,
  Loader2,
  Mic,
  Pencil,
  Save,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canLeavePreviewTab,
  registerPreviewTabLeaveGuard,
  useStore,
} from '@/store';
import type { ConversationTabValue, PreviewTab } from '@/store';
import type { OpenFileContext } from '@/types';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useSecureMedia } from '@/hooks/use-secure-media';
import { useMediaTicketUrl } from '@/hooks/use-media-ticket-url';
import { MarkdownContent } from '@/components/markdown-content-lazy';
import {
  apiFetch,
  EditableFileConflictError,
  getNativeBinaryDataUrl,
  loadEditableFile,
  parseFileContentResponse,
  readGroupFileContent,
  readRepoFileContent,
  readMountFileContent,
  mountFileContentUrl,
  readRootFileContent,
  rootFileContentUrl,
  saveBlobAsFile,
  saveEditableFile,
} from '@/lib/api';
import { API_BASE_URL } from '@/lib/api-config';
import { bytesToBase64 } from '@/lib/base64';
import { useAuth } from '@/lib/auth';
import { useProject } from '@/hooks/use-projects';
import { useDictationFailureToast, useLiveVoice } from '@/hooks/use-live-voice';
import { Button } from '@/components/ui/button';
import { ZoomableImage } from '@/components/zoomable-image';
import {
  confirmAction,
  type ConfirmOptions,
} from '@/components/confirm-dialog';
import { queryKeys } from '@/lib/query-keys';
import {
  publishOpenFileContext,
  updateOpenFileContext,
} from '@/lib/open-file-context';
import {
  FILE_DRAG_TYPE,
  PREVIEW_SELECTION_DRAG_TYPE,
  type PreviewSelectionPayload,
} from '@/lib/drag-types';
import { ConversationExplorer } from './conversation-explorer';
import {
  JsonDocumentView,
  JsonLinesView,
  useJsonlChunks,
  type JsonlChunkResult,
} from './json-preview';
import {
  FilePreviewActionsContext,
  FilePreviewHeader,
} from './file-preview-header';
import { jsonKindForPath, splitJsonlRecords } from '@/lib/json-viewer';
import type { BrowserAnnotationSubmission } from './browser-tab';

// highlight.js + its light/dark themes are already used for markdown code
// blocks (see ui/src/components/markdown-content.tsx and lib/hljs-themes.ts).
// The theme CSS is loaded eagerly at module-eval time so the very first code
// preview renders with the correct colors. The runtime is loaded lazily inside
// TextPreview so the initial bundle doesn't pay for the ~50KB hljs core until
// the user actually opens a code file.
import '@/lib/hljs-themes';

/** Largest zoom of an image in the preview pane; the frame grows up to the pane. */
const MAX_IMAGE_ZOOM = 8;

function requireRootIndex(rootIndex: number | undefined): number {
  if (rootIndex == null) throw new Error('Workspace root index missing');
  return rootIndex;
}

/**
 * Resolve a PreviewTab's `source` to a concrete fetch URL. Tabs opened by
 * callers (e.g. FilesTab) store the literal discriminator `'group' | 'repo'`
 * alongside `path`; we translate that into the corresponding content endpoint
 * here so the same renderer is used regardless of how a tab was opened. A
 * literal URL/string in `source` is still honored for back-compat with any
 * existing callers.
 */
function resolveTabFetchUrl(
  tab: {
    source?: string;
    path?: string;
    conversation_id?: string;
    repoContext?: 'main' | 'conversation';
    mountSlot?: number;
    rootIndex?: number;
  },
  project_id: string,
  conversation_id: string | null,
): string | null {
  if (!tab.source) return null;
  if (tab.source === 'mount') {
    return tab.path && tab.mountSlot
      ? mountFileContentUrl(project_id, tab.mountSlot, tab.path)
      : null;
  }
  if (tab.source === 'root') {
    return tab.path && tab.rootIndex != null
      ? rootFileContentUrl(project_id, tab.rootIndex, tab.path)
      : null;
  }
  if (tab.source === 'group') {
    if (!tab.path) return null;
    if (tab.path.startsWith('artifacts/')) {
      const artifactPath = tab.path
        .slice('artifacts/'.length)
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      if (!artifactPath) return null;
      return (
        API_BASE_URL +
        `/artifacts/${encodeURIComponent(project_id)}/${artifactPath}`
      );
    }
    return (
      API_BASE_URL +
      `/api/projects/${project_id}/files/group/content?path=${encodeURIComponent(tab.path)}`
    );
  }
  if (tab.source === 'repo') {
    if (!tab.path) return null;
    if (tab.repoContext === 'main') {
      return (
        API_BASE_URL +
        `/api/projects/${project_id}/files/repo/content?path=${encodeURIComponent(tab.path)}`
      );
    }
    // Prefer the conversation the tab was opened from so the URL stays
    // stable when the active conversation changes (repo content is
    // conversation-scoped on the backend, and worktree conversations have
    // their own checkout). Falls back to the live conversation for tabs
    // opened before this pin existed.
    const cid = tab.conversation_id ?? conversation_id;
    if (!cid) {
      return (
        API_BASE_URL +
        `/api/projects/${project_id}/files/repo/content?path=${encodeURIComponent(tab.path)}`
      );
    }
    return (
      API_BASE_URL +
      `/api/projects/${project_id}/conversations/${cid}/files/repo/content?path=${encodeURIComponent(tab.path)}`
    );
  }
  // Back-compat: treat `source` as an already-built URL/path.
  return tab.source;
}

async function readPreviewText(res: Response, url: string): Promise<string> {
  // The file-content APIs wrap text in JSON metadata, while the canonical
  // artifact route serves the copied file body directly. In particular, a
  // JSON artifact has `application/json` content but is still the file itself,
  // not a `{ content }` envelope.
  if (
    isKnowledgeFileContentUrl(url) ||
    /\/artifacts\//.test(new URL(url, window.location.origin).pathname)
  ) {
    return res.text();
  }
  const parsed = await parseFileContentResponse(res);
  if (parsed instanceof Response) {
    throw new Error('Expected text content but received binary response');
  }
  return parsed.content;
}

// Filename → mimetype fallback. Used when the PreviewTab carries no explicit
// mimetype field, or when the server only knows that the body is generic
// binary data. This lets the renderer pick the right strategy from the tab
// title without overriding an authoritative MIME type.
const EXT_MIMETYPE: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdown: 'text/markdown',
  mkd: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  // JSON Lines (one JSON object per line) is technically text. Map to
  // text/plain so the text preview path picks it up; the highlight map
  // below opts out of a language class because no single-line JSON
  // tokenizer fits per-line data cleanly.
  jsonl: 'text/plain',
  ndjson: 'text/plain',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  env: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  cc: 'text/x-c++',
  cxx: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  sql: 'text/x-sql',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  webm: 'video/webm',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
};

/**
 * Basename → mimetype for the common extensionless text files. Mirrors the
 * backend lookup in `src/lib/file-content.ts` so the client doesn't fall
 * back to "download" for files the user clearly wants to read inline. The
 * backend's JSON envelope always carries the authoritative mimetype now, so
 * this is mostly a safety net for callers that build a PreviewTab without
 * going through the fetch pipeline (e.g. UI store seeds).
 *
 * `path.extname('.gitignore')` returns '' — Node treats it as a basename,
 * not an extension. We list both the dotted and non-dotted forms so
 * `LICENSE` and `.gitignore` both resolve.
 */
const BASENAME_MIMETYPE: Record<string, string> = {
  dockerfile: 'text/plain',
  makefile: 'text/plain',
  rakefile: 'text/plain',
  gemfile: 'text/plain',
  procfile: 'text/plain',
  vagrantfile: 'text/plain',
  brewfile: 'text/plain',
  cmakelists: 'text/plain',
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
  bashrc: 'text/plain',
  bash_profile: 'text/plain',
  profile: 'text/plain',
  zshrc: 'text/plain',
  zshenv: 'text/plain',
  zprofile: 'text/plain',
  // Dotfiles (Node's path.extname returns '' for these)
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
  '.yarnrc': 'text/plain',
  '.npmrc': 'text/plain',
  '.nvmrc': 'text/plain',
  '.node-version': 'text/plain',
  '.python-version': 'text/plain',
  '.ruby-version': 'text/plain',
  '.watchmanconfig': 'text/plain',
  '.htaccess': 'text/plain',
  // Common extensionless env files
  env: 'text/plain',
  '.env': 'text/plain',
};

const MARKDOWN_MIMES = new Set(['text/markdown', 'text/x-markdown']);
const JSON_MIMES = new Set(['application/json']);

/**
 * Map file extension → highlight.js language id. We only list the languages
 * the common extensions above resolve to; an unknown extension simply
 * renders as plain monospace text (no `language-*` class is added).
 *
 * `null` means "skip highlighting even though the mimetype is text-ish" —
 * used for `text/plain` (`.txt`, `.log`, etc.) so we don't pick a wrong
 * language based on extension heuristics.
 */
const EXT_TO_HLJS_LANG: Record<string, string | null> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  json: 'json',
  jsonc: 'json',
  // JSONL/NDJSON: one JSON object per line. We don't apply hljs because the
  // json grammar is structured-object-aware and doesn't tokenize per-line
  // records cleanly — leaving it as plain monospace reads more honestly.
  jsonl: null,
  ndjson: null,
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  css: 'css',
  vue: 'xml',
  svelte: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  // These mimetypes map to text/plain in EXT_MIMETYPE — we deliberately
  // do not highlight them. Setting the value to `null` (sentinel) tells
  // TextPreview to skip adding any language class.
  txt: null,
  log: null,
  toml: null,
  ini: null,
  env: null,
  csv: null,
  tsv: null,
};

/**
 * Basename → highlight.js language id. Used for extensionless files where
 * `EXT_TO_HLJS_LANG` has no extension to look up. The backend's mimetype
 * (`Dockerfile` → `text/plain`, etc.) is too generic to drive the choice,
 * so we use the filename as the authoritative signal here. Anything not
 * listed renders as plain monospace (no `language-*` class).
 *
 * We list both the non-dotted (`dockerfile`) and dotted (`.gitignore`)
 * forms because `path.extname` returns '' for both, but `path.basename`
 * keeps the leading dot for the latter.
 */
const BASENAME_TO_HLJS_LANG: Record<string, string | null> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  rakefile: 'ruby',
  gemfile: 'ruby',
  procfile: 'plaintext',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  // Shell-ish dotfiles: do NOT highlight. They contain `export FOO=bar`,
  // `alias …`, prompts, etc. — `bash` would be misleading and any errors
  // would look like real shell bugs. Leave them as plain monospace.
  bashrc: null,
  bash_profile: null,
  profile: null,
  zshrc: null,
  zshenv: null,
  zprofile: null,
  // .gitignore / .dockerignore / .npmignore / etc. — these are list
  // formats, not any structured language. Don't try to highlight them.
  '.gitconfig': 'ini',
  '.gitignore': null,
  '.gitattributes': 'ini',
  '.gitmodules': 'ini',
  '.hgignore': null,
  '.npmignore': null,
  '.dockerignore': null,
  '.eslintignore': null,
  '.prettierignore': null,
  '.editorconfig': 'ini',
  '.babelrc': 'json',
  '.yarnrc': 'yaml',
  '.npmrc': 'ini',
  '.nvmrc': 'plaintext',
  '.node-version': 'plaintext',
  '.python-version': 'plaintext',
  '.ruby-version': 'plaintext',
  '.watchmanconfig': 'json',
  '.htaccess': 'apache',
  // `.env*` — these are usually shell-style `KEY=value` lines, but they
  // are *not* bash scripts (no expansions, no flow control). Highlighting
  // them as bash is more confusing than helpful. Plain text is clearer.
  '.env': null,
  env: null,
  // Markdown-y project meta
  readme: 'markdown',
  contributing: 'markdown',
  code_of_conduct: 'markdown',
  changelog: 'markdown',
  security: 'markdown',
  // Plain text project meta
  license: null,
  licence: null,
  copying: null,
  authors: null,
  contributors: null,
  notice: null,
};

/**
 * Cap on how much of a text/code file we'll dump into the DOM. Files above
 * this get the "too large" fallback (metadata + download link) instead of a
 * `<pre>` tree, so the preview pane stays responsive even when the user opens
 * a multi-megabyte log or dump by accident.
 *
 * 500 KiB ≈ ~500k chars of ASCII text — large enough that almost every
 * source file renders fine, small enough that we never paint a DOM tree
 * that would lock up the browser.
 */
const TEXT_PREVIEW_MAX_BYTES = 500 * 1024;

type LocalEditableSource = 'group' | 'artifact';

function editableTabIdentity(
  tab: PreviewTab,
): { source: LocalEditableSource; path: string } | null {
  if (tab.source !== 'group' || !tab.path) return null;
  if (tab.path.startsWith('artifacts/')) {
    const path = tab.path.slice('artifacts/'.length);
    return path ? { source: 'artifact', path } : null;
  }
  return { source: 'group', path: tab.path };
}

export function insertTextAtTextareaSelection(
  textarea: HTMLTextAreaElement,
  phrase: string,
): string {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next =
    textarea.value.slice(0, start) + phrase + textarea.value.slice(end);
  textarea.value = next;
  textarea.setSelectionRange(start + phrase.length, start + phrase.length);
  return next;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * Dotfile basenames that are binary despite living at the repo root with a
 * leading dot. Mirrors `BINARY_DOTFILES` in `src/lib/file-content.ts` so the
 * client's routing decision matches the backend's text/binary split. Keeps
 * the dotfile fallback below from sending `.DS_Store` etc. through the text
 * renderer (where it would show garbage bytes).
 */
const BINARY_DOTFILES = new Set(['.ds_store']);

function resolveMimetype(tab: {
  title: string;
  path?: string;
  mimetype?: string;
}): string {
  const explicitMimetype = tab.mimetype?.split(';', 1)[0]?.trim();
  if (
    explicitMimetype &&
    explicitMimetype.toLowerCase() !== 'application/octet-stream'
  )
    return explicitMimetype;
  const name = tab.path ?? tab.title;
  // Extension first; fall back to basename for extensionless files.
  const ext = extOf(name);
  if (ext && EXT_MIMETYPE[ext]) return EXT_MIMETYPE[ext];
  // `path.basename` mirrors what the backend does; lower-cased so the
  // lookup is case-insensitive (LICENSE / License / license all match).
  const segments = name.replace(/\\/g, '/').split('/');
  const base = segments[segments.length - 1]?.toLowerCase() ?? '';
  if (base && BASENAME_MIMETYPE[base]) return BASENAME_MIMETYPE[base];
  // Unrecognised dotfiles (.prettierrc, .env.example, .env.local, .gitkeep,
  // …) are almost always small text config the user wants to read inline,
  // not download. Known binary extensions (png/pdf/etc.) were already
  // returned by the extension lookup above, so a dotfile reaching here is
  // text-ish. Excludes the handful of known-binary dotfile basenames.
  if (base.startsWith('.') && base.length > 1 && !BINARY_DOTFILES.has(base)) {
    return 'text/plain';
  }
  return explicitMimetype ?? '';
}

/**
 * Returns a highlight.js language id for the tab, or `null` if the file
 * should render as plain monospace text (no highlighting). The sentinel
 * `null` is distinct from "language not found" — see EXT_TO_HLJS_LANG.
 */
function resolveHljsLang(tab: { title: string; path?: string }): string | null {
  const name = tab.path ?? tab.title;
  const ext = extOf(name);
  if (ext in EXT_TO_HLJS_LANG) return EXT_TO_HLJS_LANG[ext];
  // No extension (or unknown one) — try the basename lookup for known
  // extensionless text files. The lookup is case-insensitive.
  const segments = name.replace(/\\/g, '/').split('/');
  const base = segments[segments.length - 1]?.toLowerCase() ?? '';
  if (base in BASENAME_TO_HLJS_LANG) return BASENAME_TO_HLJS_LANG[base];
  return null;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isLikelyText(mimetype: string): boolean {
  if (!mimetype) return false;
  if (mimetype.startsWith('text/')) return true;
  if (JSON_MIMES.has(mimetype)) return true;
  if (/^application\/.+\+(json|xml)$/.test(mimetype)) return true;
  // Code-ish mimetypes we list above all start with text/, but be defensive
  // about the common "application/*" forms that are still plain text bodies.
  if (mimetype === 'application/xml' || mimetype === 'application/x-yaml')
    return true;
  return false;
}

/**
 * Character offset of `node`@`offset` within `container`'s flattened text
 * content. Built with a range from the start of `container` to the
 * (node, offset) point so it works whether the selection boundary lands on a
 * text node (character offset) or an element node (child index) — the latter
 * happens when a selection starts at the very first character of a `<code>`
 * block after highlight.js has wrapped tokens in spans.
 */
function charOffsetWithin(container: Node, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/**
 * Map the current window selection to a 1-based source line range, but only
 * when the selection lives inside a single `<pre data-file-lines>` element —
 * i.e. the full-file `TextPreview` renderer, where the pre's text content IS
 * the file body and line numbers are meaningful. Returns null for rendered
 * markdown (line numbers don't map to source) and the chunked large-file
 * renderer (each pre is a windowed slice, not the whole file).
 */
export function selectionLineRange(
  container: HTMLElement,
  sel: Selection,
): { start: number; end: number } | null {
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // Climb from the selection start to the nearest <pre data-file-lines>.
  let el = range.startContainer.parentElement;
  while (el && el !== container && !el.hasAttribute('data-file-lines')) {
    el = el.parentElement;
  }
  if (!el || el === container || !el.hasAttribute('data-file-lines'))
    return null;
  const preText = el.textContent ?? '';
  const startOffset = charOffsetWithin(
    el,
    range.startContainer,
    range.startOffset,
  );
  const startLine =
    (preText.slice(0, startOffset).match(/\n/g)?.length ?? 0) + 1;
  const selText = sel.toString();
  const endLine = startLine + (selText.match(/\n/g)?.length ?? 0);
  return { start: startLine, end: endLine };
}

export function sourcePosition(pre: HTMLElement, node: Node, offset: number) {
  const text = pre.textContent ?? '';
  const absolute = charOffsetWithin(pre, node, offset);
  const before = text.slice(0, absolute);
  return {
    line: (before.match(/\n/g)?.length ?? 0) + 1,
    column: absolute - before.lastIndexOf('\n'),
  };
}

export function previewTabOpenFileContext(
  tab: PreviewTab,
  conversationId: string | null,
): OpenFileContext | null {
  if (!tab.path || tab.source === 'mount' || tab.source === 'root') return null;
  if (
    Object.prototype.hasOwnProperty.call(
      tab,
      'openFileContextConversationId',
    ) &&
    tab.openFileContextConversationId !== conversationId
  ) {
    return null;
  }
  if (
    tab.source === 'repo' &&
    tab.repoContext !== 'main' &&
    (!conversationId ||
      (!!tab.conversation_id && tab.conversation_id !== conversationId))
  ) {
    return null;
  }
  const source =
    tab.source === 'repo'
      ? 'repo'
      : tab.path.startsWith('artifacts/')
        ? 'artifact'
        : 'group';
  return {
    source,
    path:
      source === 'artifact' ? tab.path.slice('artifacts/'.length) : tab.path,
    ...(source === 'repo'
      ? {
          repoContext:
            tab.repoContext === 'main'
              ? ('main' as const)
              : ('conversationWorktree' as const),
          ...(tab.repoContext === 'main'
            ? {}
            : {
                conversationId:
                  tab.conversation_id ?? conversationId ?? undefined,
              }),
        }
      : {}),
  };
}

function visiblePreviewTabOpenFileContext(
  tab: PreviewTab | null,
  previewBodyVisible: boolean,
  conversationId: string | null,
) {
  return tab && previewBodyVisible
    ? previewTabOpenFileContext(tab, conversationId)
    : null;
}

/**
 * Per-tab header used by both the inline tab strip and active-tab rendering.
 * Reads from the store; mutations go back through the store actions so the
 * tab strip and content stay in sync.
 *
 * Each tab is a `<div role="tab">` (not a `<button>`) so the close control
 * can be a sibling `<button>` — nesting interactive elements is invalid
 * HTML and an ARIA anti-pattern. Activation is wired through onClick +
 * Enter/Space onKeyDown so keyboard users still get the expected behavior.
 */
function PreviewTabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  isPreviewActive = true,
}: {
  tabs: {
    id: string;
    title: string;
    path?: string;
    source?: string;
    containerPath?: string;
  }[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /**
   * Whether the preview pane is the current body in ConversationExplorer.
   * When false (the user is on Artifacts/Changes/Files), no file tab is
   * highlighted — so the user can see at a glance that the strip is a
   * set of inactive breadcrumbs and click any of them to re-focus the
   * preview on that file. The store's `activeTabId` is still tracked so
   * the right preview tab is re-selected when the user clicks back.
   */
  isPreviewActive?: boolean;
}) {
  return (
    <div
      role="tablist"
      className="flex items-stretch overflow-x-auto border-b border-border bg-muted/30"
    >
      {tabs.map((t) => {
        const active = isPreviewActive && t.id === activeTabId;
        // A tab carrying a file path is draggable into the chat input —
        // same dataTransfer contract as a row dragged from the Files tree,
        // so the chat drop handler turns it into an `@<path>` mention.
        const draggable = !!t.path;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            draggable={draggable}
            onDragStart={(e) => {
              if (!t.path) return;
              const knowledge = t.source
                ? parseKnowledgeReference(t.source)
                : null;
              if (knowledge) {
                e.dataTransfer.setData(
                  KNOWLEDGE_DRAG_TYPE,
                  JSON.stringify(knowledge),
                );
                e.dataTransfer.setData(
                  'text/plain',
                  knowledgeReferenceMarkdown(knowledge),
                );
                e.dataTransfer.effectAllowed = 'copy';
                return;
              }
              const dragPath = t.containerPath ?? t.path;
              e.dataTransfer.setData(FILE_DRAG_TYPE, dragPath);
              e.dataTransfer.setData('text/plain', '@' + dragPath);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onActivate(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate(t.id);
              }
            }}
            className={[
              'group flex items-center gap-1.5 px-2 py-1.5 text-xs border-r border-border shrink-0 max-w-[200px] cursor-pointer outline-none focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring',
              draggable ? 'active:cursor-grabbing' : '',
              active
                ? 'bg-background text-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground',
            ].join(' ')}
            title={t.title}
          >
            <span className="truncate flex-1 pl-1">{t.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              aria-label={`Close ${t.title}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface PreviewTextState {
  text: string | null;
  error: string | null;
  loading: boolean;
  tooLarge: { size: number } | null;
  /** Byte size for the metadata header. Sourced from the HEAD Content-Length
   *  probe when available, falling back to the fetched body's length so the
   *  header still shows a size when HEAD didn't report one. */
  size: number | null;
}

/**
 * Fetch a text file for preview: HEAD-probe the size first (so oversized
 * files are never pulled), then GET the body and re-check the cap. Pass
 * `null` to skip fetching (the caller already has the text).
 */
function usePreviewText(url: string | null): PreviewTextState {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(url != null);
  const [tooLarge, setTooLarge] = useState<{ size: number } | null>(null);
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    if (url == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    setTooLarge(null);
    setSize(null);
    (async () => {
      try {
        // Probe size first so we can short-circuit on huge files without
        // pulling the body. Some servers don't implement HEAD — fall back
        // to GET if HEAD 404s/405s, but keep the same cap check by reading
        // the body length after.
        let probedSize: number | null = null;
        try {
          const headRes = await apiFetch(url, { method: 'HEAD' });
          if (headRes.ok) {
            const len = headRes.headers.get('Content-Length');
            if (len && /^\d+$/.test(len)) probedSize = Number(len);
          }
        } catch {
          // HEAD isn't available — fall through to GET below.
        }
        if (probedSize != null && probedSize > TEXT_PREVIEW_MAX_BYTES) {
          if (!cancelled) setTooLarge({ size: probedSize });
          return;
        }
        let sizeKnown: number | null = probedSize;
        if (probedSize != null) setSize(probedSize);
        const res = await apiFetch(url);
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        const body = await readPreviewText(res, url);
        if (cancelled) return;
        // Fallback cap: even if HEAD was missing/wrong, never render a
        // body bigger than the cap. Use `body.length` (UTF-16 code units,
        // matching the cap check) rather than `new Blob([body]).size`
        // (UTF-8 bytes) — the two can differ for non-ASCII content, and
        // the cap check above already operates in code units.
        if (body.length > TEXT_PREVIEW_MAX_BYTES) {
          setTooLarge({ size: body.length });
          return;
        }
        // If HEAD didn't report a size, fall back to the body's code-unit
        // length so the metadata header still shows something — same unit
        // as the cap check above, so the numbers are comparable.
        if (sizeKnown === null) {
          const bodyLength = body.length;
          sizeKnown = bodyLength;
          setSize(bodyLength);
        }
        setText(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { text, error, loading, tooLarge, size };
}

/** Loading / error / too-large placeholder for a text preview, else null. */
function previewTextStatus(
  state: Pick<PreviewTextState, 'loading' | 'error' | 'tooLarge'>,
  url: string,
  title: string,
  mimetype: string,
): ReactNode {
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="text-xs text-destructive p-4">
        Could not load file: {state.error}
      </div>
    );
  }
  if (state.tooLarge) {
    return (
      <BinaryDownloadPreview
        url={url}
        title={title}
        mimetype={mimetype}
        size={state.tooLarge.size}
        reason={`File too large to preview (${formatBytes(state.tooLarge.size)} > ${formatBytes(TEXT_PREVIEW_MAX_BYTES)})`}
      />
    );
  }
  return null;
}

/**
 * Text/code renderer: fetch the file as text and dump into a <pre>. Kept as
 * its own component so the fetch lifecycle (loading/error/empty) is isolated
 * from the binary renderers above.
 *
 * Files larger than {@link TEXT_PREVIEW_MAX_BYTES} never get their body
 * pulled — we probe with HEAD first so the user gets a download prompt
 * instead of a multi-megabyte DOM tree that locks up the browser.
 *
 * When `hljsLang` is non-null the body is rendered as a `<pre><code
 * class="language-…">` and run through `hljs.highlightElement()` so code
 * files (`.ts`, `.py`, `.json`, …) get the same theme-aware syntax colors
 * used by markdown code blocks elsewhere in the app. The hljs runtime is
 * lazy-imported so the initial bundle doesn't pay for it.
 */
function TextPreview({
  url,
  title,
  path,
  mimetype,
  hljsLang,
  preloaded,
  embedded = false,
}: {
  url: string;
  title: string;
  /** Repo/group-relative path, shown in the metadata header so two
   *  same-named files in different folders can be told apart. Falls back
   *  to `title` (the bare filename) when absent. */
  path?: string;
  mimetype: string;
  hljsLang: string | null;
  /** Already-fetched body (e.g. by a structured JSON view that also offers
   *  this raw view); skips the fetch. */
  preloaded?: { text: string; size: number | null };
  /** Omit the header when a parent view (JSON Raw mode) already draws one. */
  embedded?: boolean;
}) {
  const fetched = usePreviewText(preloaded ? null : url);
  const { text, error, loading, tooLarge, size } = preloaded
    ? {
        text: preloaded.text,
        error: null,
        loading: false,
        tooLarge: null,
        size: preloaded.size,
      }
    : fetched;
  const codeRef = useRef<HTMLElement | null>(null);

  // Apply syntax highlighting after the body is in the DOM. Lazy-loads the
  // hljs runtime on first code preview so users who only ever open images
  // / markdown / binary files never download it.
  useEffect(() => {
    if (text == null || !hljsLang || !codeRef.current) return;
    let cancelled = false;
    import('highlight.js').then((mod) => {
      if (cancelled || !codeRef.current) return;
      // highlight.js is a CJS module; esModuleInterop gives us both `mod`
      // and `mod.default` pointing at the same namespace. We pick the one
      // that actually exposes `highlightElement`.
      const hljs = (mod.default ?? mod) as unknown as {
        highlightElement: (el: HTMLElement) => void;
      };
      hljs.highlightElement(codeRef.current!);
    });
    return () => {
      cancelled = true;
    };
  }, [text, hljsLang]);

  const status = previewTextStatus(
    { loading, error, tooLarge },
    url,
    title,
    mimetype,
  );
  if (status) return status;
  // Code files: render as a <pre><code class="language-…"> so hljs can
  // pick the right tokenizer. Plain text (hljsLang === null) keeps the
  // original bare-<pre> styling. The metadata header (mimetype + size)
  // mirrors `TextPreviewChunked` so the bar is visible for every text
  // preview, not just the chunked large-file renderer. The header shows
  // the relative path (not just the filename) so two same-named files in
  // different folders can be told apart.
  const headerLabel = path ?? title;
  return (
    <div className="h-full w-full flex flex-col">
      {!embedded && (
        <FilePreviewHeader
          label={headerLabel}
          mimetype={mimetype}
          meta={size != null ? <span>{formatBytes(size)}</span> : null}
        />
      )}
      {hljsLang ? (
        <pre
          data-file-lines
          data-ui="read-only-file-focus-location"
          className="hljs text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words p-3 m-0 overflow-auto flex-1 min-h-0"
        >
          <code ref={codeRef} className={`language-${hljsLang}`}>
            {text ?? ''}
          </code>
        </pre>
      ) : (
        <pre
          data-file-lines
          data-ui="read-only-file-focus-location"
          className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words p-3 m-0 overflow-auto flex-1 min-h-0"
        >
          {text ?? ''}
        </pre>
      )}
    </div>
  );
}

/**
 * `.json` / `.jsonc` / `.json5` preview: a collapsible tree whose Raw mode is
 * the regular highlighted {@link TextPreview}, fed the already-fetched body
 * so the file is only requested once.
 */
function JsonDocumentPreview({
  url,
  title,
  path,
  mimetype,
  hljsLang,
}: {
  url: string;
  title: string;
  path?: string;
  mimetype: string;
  hljsLang: string | null;
}) {
  const state = usePreviewText(url);
  const status = previewTextStatus(state, url, title, mimetype);
  if (status) return status;
  const text = state.text ?? '';
  return (
    <JsonDocumentView
      text={text}
      label={path ?? title}
      mimetype={mimetype}
      sizeLabel={formatBytes(state.size)}
      rawView={
        <TextPreview
          url={url}
          title={title}
          path={path}
          mimetype={mimetype}
          hljsLang={hljsLang}
          preloaded={{ text, size: state.size }}
          embedded
        />
      }
    />
  );
}

/** Small `.jsonl` / `.ndjson` preview from a single fetch (no chunk source). */
function JsonLinesPreview({
  url,
  title,
  path,
  mimetype,
}: {
  url: string;
  title: string;
  path?: string;
  mimetype: string;
}) {
  const state = usePreviewText(url);
  const text = state.text ?? '';
  const records = useMemo(
    () =>
      splitJsonlRecords(text.endsWith('\n') ? text : `${text}\n`, 1).records,
    [text],
  );
  const status = previewTextStatus(state, url, title, mimetype);
  if (status) return status;
  return (
    <JsonLinesView
      records={records}
      label={path ?? title}
      mimetype={mimetype}
      sizeLabel={formatBytes(state.size)}
      formatBytes={formatBytes}
      rawView={
        <TextPreview
          url={url}
          title={title}
          path={path}
          mimetype={mimetype}
          hljsLang={null}
          preloaded={{ text, size: state.size }}
          embedded
        />
      }
    />
  );
}

/**
 * Large `.jsonl` / `.ndjson` preview: records are loaded window by window
 * through the same ranged content endpoints as {@link TextPreviewChunked}.
 */
function JsonLinesChunkedPreview({
  source,
  mountSlot,
  rootIndex,
  project_id,
  conversation_id,
  path,
  title,
  mimetype,
  size,
}: {
  source: 'group' | 'repo' | 'mount' | 'root';
  mountSlot?: number;
  rootIndex?: number;
  project_id: string;
  conversation_id: string | null;
  path: string;
  title: string;
  mimetype: string;
  size: number | null | undefined;
}) {
  const readChunk = useCallback(
    async (offset: number, length: number): Promise<JsonlChunkResult> => {
      const range = { offset, length };
      const res =
        source === 'group'
          ? await readGroupFileContent(project_id, path, range)
          : source === 'root'
            ? await readRootFileContent(
                project_id,
                requireRootIndex(rootIndex),
                path,
                range,
              )
            : source === 'mount'
              ? await readMountFileContent(
                  project_id,
                  mountSlot ?? 0,
                  path,
                  range,
                )
              : await readRepoFileContent(
                  project_id,
                  conversation_id,
                  path,
                  range,
                );
      if (res instanceof Response) {
        throw new Error('Expected text content but received binary response');
      }
      return { content: res.content, total: res.total };
    },
    [source, mountSlot, rootIndex, project_id, conversation_id, path],
  );
  const loader = useJsonlChunks(readChunk, size);
  return (
    <JsonLinesView
      records={loader.records}
      loader={loader}
      label={path}
      mimetype={mimetype}
      sizeLabel={loader.total != null ? formatBytes(loader.total) : ''}
      formatBytes={formatBytes}
      rawView={
        <TextPreviewChunked
          source={source}
          mountSlot={mountSlot}
          rootIndex={rootIndex}
          project_id={project_id}
          conversation_id={conversation_id}
          path={path}
          title={title}
          mimetype={mimetype}
          size={size}
          embedded
        />
      }
    />
  );
}

/**
 * Inline media renderer — fetches media through the existing authenticated
 * path, then gives the browser/WebView the resulting source. Native controls
 * handle playback and seeking; no media is started automatically.
 */
function stopPreviewMedia(
  element: HTMLMediaElement | HTMLImageElement | null,
): void {
  if (!(element instanceof HTMLMediaElement)) return;
  element.pause();
  element.removeAttribute('src');
  element.load();
}

function MediaPreview({
  url,
  title,
  mimetype,
  size,
  kind,
  isVisible,
}: {
  url: string;
  title: string;
  mimetype: string;
  size: number | null | undefined;
  kind: 'image' | 'video' | 'audio';
  isVisible: boolean;
}) {
  // Video and audio stream from a ticketed URL (Range requests, no native
  // base64 round trip). Images, and media the board issues no ticket for
  // (e.g. signed knowledge files), keep the secure-media fetch.
  const ticket = useMediaTicketUrl(kind === 'image' ? null : url);
  const streamed = ticket.url !== null;
  const secure = useSecureMedia(ticket.pending || streamed ? null : url);
  const secureUrl = streamed ? ticket.url : secure.secureUrl;
  const loading = ticket.pending || (!streamed && secure.loading);
  const error = streamed ? null : secure.error;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  if (error || !secureUrl) {
    return (
      <BinaryDownloadPreview
        url={url}
        title={title}
        mimetype={mimetype}
        size={size}
        reason="Preview unavailable: this media could not be loaded or decoded."
      />
    );
  }

  // Mounted with its resolved URL: its effects then attach the source after
  // any ref detach/reattach of a new media element (StrictMode), which an
  // already-mounted parent's effects would not re-run for.
  return (
    <LoadedMediaPreview
      key={secureUrl}
      url={url}
      secureUrl={secureUrl}
      title={title}
      mimetype={mimetype}
      size={size}
      kind={kind}
      isVisible={isVisible}
    />
  );
}

function LoadedMediaPreview({
  url,
  secureUrl,
  title,
  mimetype,
  size,
  kind,
  isVisible,
}: {
  url: string;
  secureUrl: string;
  title: string;
  mimetype: string;
  size: number | null | undefined;
  kind: 'image' | 'video' | 'audio';
  isVisible: boolean;
}) {
  const mediaRef = useRef<HTMLMediaElement | HTMLImageElement | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const setMediaRef = useCallback(
    (element: HTMLMediaElement | HTMLImageElement | null) => {
      if (mediaRef.current && mediaRef.current !== element) {
        stopPreviewMedia(mediaRef.current);
      }
      mediaRef.current = element;
    },
    [],
  );

  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    if (!isVisible) {
      stopPreviewMedia(element);
      return;
    }
    // Hiding the preview removes the media element's source so the browser
    // releases its buffered resource. Reattach it when the preview becomes
    // visible again; setting src/load never starts playback by itself.
    if (element instanceof HTMLMediaElement) {
      if (element.getAttribute('src') !== secureUrl) {
        element.setAttribute('src', secureUrl);
        element.load();
      }
    }
  }, [isVisible, secureUrl]);

  useEffect(() => {
    return () => stopPreviewMedia(mediaRef.current);
  }, []);

  const imageBoxRef = useRef<HTMLDivElement>(null);
  const getImageBoxSize = useCallback(
    () => ({
      width: imageBoxRef.current?.clientWidth ?? Infinity,
      height: imageBoxRef.current?.clientHeight ?? Infinity,
    }),
    [],
  );

  const handleMediaError = () => {
    stopPreviewMedia(mediaRef.current);
    setDecodeError(true);
  };

  if (decodeError) {
    return (
      <BinaryDownloadPreview
        url={url}
        title={title}
        mimetype={mimetype}
        size={size}
        reason="Preview unavailable: this media could not be loaded or decoded."
      />
    );
  }

  const download = (
    <div className="shrink-0 border-t border-border/50 bg-background px-3 py-2">
      <AuthenticatedDownloadLink
        url={url}
        href={secureUrl}
        title={title}
        className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
      >
        <Download className="size-3.5" />
        Download
      </AuthenticatedDownloadLink>
    </div>
  );

  if (kind === 'image') {
    return (
      <div
        className="h-full w-full overflow-hidden flex flex-col bg-muted/30"
        data-ui="file-preview-image"
      >
        {/* The inner box is the pane's size and a size container, so the image
            fits it at 1x (cq units) and the zoom frame may grow up to it. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={imageBoxRef}
            className="absolute inset-3 flex items-center justify-center [container-type:size]"
          >
            <ZoomableImage
              src={secureUrl}
              alt={title}
              maxFrameGrowth={MAX_IMAGE_ZOOM}
              getMaxFrameSize={getImageBoxSize}
              className="max-h-[100cqh] max-w-[100cqw] object-contain"
              onError={handleMediaError}
            />
          </div>
        </div>
        {download}
      </div>
    );
  }

  return (
    <div
      className="h-full w-full overflow-hidden flex flex-col bg-muted/30"
      data-ui={`file-preview-${kind}`}
    >
      <div className="min-h-0 flex-1 overflow-auto p-3 flex items-center justify-center">
        {kind === 'video' ? (
          <video
            ref={setMediaRef}
            src={secureUrl}
            title={title}
            controls
            preload="metadata"
            className="max-h-full max-w-full object-contain"
            onError={handleMediaError}
          />
        ) : (
          <audio
            ref={setMediaRef}
            src={secureUrl}
            controls
            preload="metadata"
            className="w-full max-w-xl"
            onError={handleMediaError}
          />
        )}
      </div>
      {download}
    </div>
  );
}

/**
 * PDF viewer — browser-native via an iframe with a blob URL so the auth
 * header isn't leaked into the src. (Same secure-fetch pattern as images.)
 */
function PdfPreview({
  url,
  title,
  size,
}: {
  url: string;
  title: string;
  size?: number | null;
}) {
  const { secureUrl, loading, error } = useSecureMedia(url);
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }
  if (error || !secureUrl) {
    return (
      <div className="text-xs text-destructive p-4">
        Could not load PDF{error ? `: ${error.message}` : ''}.
      </div>
    );
  }
  if (navigator.pdfViewerEnabled === false) {
    return (
      <BinaryDownloadPreview
        url={url}
        title={title}
        mimetype="application/pdf"
        size={size}
        reason="This browser does not support inline PDF previews. Download the PDF to read it."
      />
    );
  }
  return (
    <iframe
      src={secureUrl}
      className="w-full h-full bg-background"
      title="PDF preview"
    />
  );
}

/**
 * Fallback for binary files we can't render inline: show metadata and offer a
 * download. The <a download> works because the server sends the right
 * Content-Disposition once apiFetch's Authorization header authenticates the
 * request.
 *
 * Also used as the "too large" fallback when a text/markdown file exceeds
 * the {@link TEXT_PREVIEW_MAX_BYTES} cap — `reason` then explains why we're
 * not showing the body inline.
 */
function BinaryDownloadPreview({
  url,
  title,
  mimetype,
  size,
  reason,
}: {
  url: string;
  title: string;
  mimetype: string;
  size: number | null | undefined;
  reason?: string;
}) {
  const href = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
  return (
    <div className="h-full w-full flex items-center justify-center p-6">
      <div className="rounded-lg border border-border bg-muted/30 p-6 flex flex-col items-center gap-3 max-w-sm text-center">
        <Download className="size-8 text-muted-foreground" />
        <div className="text-sm font-medium break-all">{title}</div>
        {reason && (
          <div className="text-xs text-muted-foreground">{reason}</div>
        )}
        <div className="text-xs text-muted-foreground flex flex-col gap-0.5">
          {mimetype && <span className="font-mono">{mimetype}</span>}
          {size != null && <span>{formatBytes(size)}</span>}
        </div>
        <AuthenticatedDownloadLink
          url={url}
          href={href}
          title={title}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90"
        >
          <Download className="size-3.5" />
          Download
        </AuthenticatedDownloadLink>
      </div>
    </div>
  );
}

async function responseToBase64(response: Response): Promise<string> {
  const native = getNativeBinaryDataUrl(response);
  if (native) return native.base64;
  return bytesToBase64(new Uint8Array(await response.arrayBuffer()));
}

function nativeDownloadPath(title: string): string {
  const fileName =
    title
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download';
  return `CarapaBoard/${Date.now()}-${fileName}`;
}

export function AuthenticatedDownloadLink({
  url,
  href,
  title,
  className,
  children,
}: {
  url: string;
  href: string;
  title: string;
  className: string;
  children: ReactNode;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    const native = Capacitor.isNativePlatform();
    if (!native && !isKnowledgeFileContentUrl(url)) return;
    event.preventDefault();
    if (downloading) return;

    setDownloading(true);
    setDownloadError(false);
    try {
      const requestUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
      const response = await apiFetch(requestUrl);
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
      if (!native) {
        saveBlobAsFile(await response.blob(), title);
        return;
      }
      await Filesystem.writeFile({
        path: nativeDownloadPath(title),
        data: await responseToBase64(response),
        directory: Directory.Documents,
        recursive: true,
      });
    } catch (error) {
      console.error('Native preview download failed:', error);
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <a
        href={href}
        download={title}
        aria-busy={downloading}
        className={`${className}${downloading ? ' pointer-events-none opacity-60' : ''}`}
        onClick={(event) => void handleClick(event)}
      >
        {children}
      </a>
      {downloadError && (
        <span role="alert" className="text-xs text-destructive">
          Could not download file.
        </span>
      )}
    </>
  );
}

/**
 * Chunked text renderer for files larger than {@link TEXT_PREVIEW_MAX_BYTES}.
 *
 * Loads the file in {@link CHUNK_SIZE} byte windows instead of pulling the
 * whole body up front. The first chunk is taken from the head of the file
 * for most extensions, or from the tail for log files (`.log`, …) so the
 * user lands on the most recent entries — same behaviour as `tail -f`.
 *
 * Once the first window is rendered, the user scrolls to fetch more:
 * when scrolled near the bottom, the next window (by byte offset) is fetched
 * and appended, for both head-first and tail-first files.
 * Loads are debounced through `loadingRef` so rapid scroll events only
 * fire one network request each.
 *
 * hljs is deliberately *not* applied: the file is too big to tokenise in
 * one pass, and chunks may begin mid-token which produces broken
 * highlighting. The monospace plain-text rendering is honest about what
 * we're showing.
 *
 * The source prop identifies which content endpoint to call. We deliberately
 * don't reuse the high-level `apiFetch` + URL construction because the
 * chunked reads append `offset` / `length` query params, and routing
 * through the existing helpers (`readGroupFileContent` /
 * `readRepoFileContent`) keeps auth and content-type handling consistent.
 */
const CHUNK_SIZE = 20 * 1024;
/**
 * Files below this size go through the regular `TextPreview` renderer.
 * The chunked path is meant for files that meaningfully stress the DOM,
 * not for tiny reads that fit comfortably in a single fetch.
 */
const CHUNKED_PREVIEW_THRESHOLD = 100 * 1024;

/** True when a filename looks like a log file (tail-first loading). */
function isLogLike(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.log')) return true;
  // Common log-by-convention names: error.log, app.log, server.log, etc.
  return false;
}

export function TextPreviewChunked({
  source,
  mountSlot,
  rootIndex,
  project_id,
  conversation_id,
  path,
  title,
  mimetype,
  size,
  embedded = false,
}: {
  source: 'group' | 'repo' | 'mount' | 'root';
  mountSlot?: number;
  rootIndex?: number;
  project_id: string;
  conversation_id: string | null;
  path: string;
  title: string;
  mimetype: string;
  size: number | null | undefined;
  /** Omit the header when a parent view (JSONL Raw mode) already draws one. */
  embedded?: boolean;
}) {
  const tailFirst = isLogLike(path);
  // We store the file as an ordered list of { offset, length, text } chunks.
  // `offset` / `length` are BYTES as reported by the server; `text.length` is
  // UTF-16 code units and must not be used for offset arithmetic. A single
  // chunk is always present after the first load; subsequent loads append.
  const [chunks, setChunks] = useState<
    Array<{ offset: number; length: number; text: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState<number | null>(
    typeof size === 'number' ? size : null,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  // Build the chunked-read URL once. We share this between the HEAD probe
  // and `readGroupFileContent`/`readRepoFileContent` (which append
  // `offset` / `length` separately) so the routing decision is made in one
  // place.
  const baseUrl = useMemo(() => {
    if (source === 'group') {
      return `${API_BASE_URL}/api/projects/${project_id}/files/group/content?path=${encodeURIComponent(path)}`;
    }
    if (source === 'mount' && mountSlot) {
      return mountFileContentUrl(project_id, mountSlot, path);
    }
    if (source === 'root' && rootIndex != null) {
      return rootFileContentUrl(project_id, rootIndex, path);
    }
    if (source === 'repo') {
      return conversation_id
        ? `${API_BASE_URL}/api/projects/${project_id}/conversations/${conversation_id}/files/repo/content?path=${encodeURIComponent(path)}`
        : `${API_BASE_URL}/api/projects/${project_id}/files/repo/content?path=${encodeURIComponent(path)}`;
    }
    return null;
  }, [source, mountSlot, rootIndex, project_id, conversation_id, path]);

  /**
   * Probe the file's size via HEAD. Returns null when HEAD is unavailable
   * or the server didn't send Content-Length. Used by the first-load path
   * for tail-first files (so we can compute the initial offset) and as a
   * safety net when the caller didn't pre-populate `size`.
   */
  const probeSize = useCallback(async (): Promise<number | null> => {
    if (!baseUrl) return null;
    try {
      const headRes = await apiFetch(baseUrl, { method: 'HEAD' });
      if (!headRes.ok) return null;
      const len = headRes.headers.get('Content-Length');
      if (len && /^\d+$/.test(len)) return Number(len);
      return null;
    } catch {
      return null;
    }
  }, [baseUrl]);

  // Fetch a single chunk and append it to `chunks`.
  // We pass `seed` so the closure in the effect doesn't capture a stale
  // empty `chunks` array; the updater reads the latest value via the
  // functional form.
  const fetchChunk = useCallback(
    async (offset: number) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const range = { offset, length: CHUNK_SIZE };
        const res =
          source === 'group'
            ? await readGroupFileContent(project_id, path, range)
            : source === 'root'
              ? await readRootFileContent(
                  project_id,
                  requireRootIndex(rootIndex),
                  path,
                  range,
                )
              : source === 'mount'
                ? await readMountFileContent(
                    project_id,
                    mountSlot ?? 0,
                    path,
                    range,
                  )
                : await readRepoFileContent(
                    project_id,
                    conversation_id,
                    path,
                    range,
                  );
        if (res instanceof Response) {
          throw new Error('Expected text content but received binary response');
        }
        const chunkOffset = res.offset ?? offset;
        const chunkLength = res.length ?? res.content.length;
        const t =
          typeof res.total === 'number' ? res.total : chunkOffset + chunkLength;
        setTotal(t);
        const chunk = {
          offset: chunkOffset,
          length: chunkLength,
          text: res.content,
        };
        setChunks((prev) => {
          // Avoid double-appending if the user managed to scroll twice
          // before this fetch resolved.
          if (prev.length > 0 && prev[prev.length - 1].offset === chunkOffset) {
            return prev;
          }
          return [...prev, chunk];
        });
      } finally {
        loadingRef.current = false;
      }
    },
    [source, mountSlot, rootIndex, project_id, conversation_id, path],
  );

  // First-load effect: kick off the head- or tail-first initial fetch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChunks([]);
    (async () => {
      try {
        if (tailFirst) {
          // We need the total size to compute the tail offset. The
          // caller may have pre-populated it; if not, HEAD-probe.
          let t: number | null = typeof size === 'number' ? size : total;
          if (t == null) t = await probeSize();
          if (cancelled) return;
          if (t != null) setTotal(t);
          if (t == null) {
            // No way to know the size — fall back to head-first.
            await fetchChunk(0);
            return;
          }
          // Aim for the last CHUNK_SIZE bytes; clamp to non-negative.
          const start = Math.max(0, t - CHUNK_SIZE);
          await fetchChunk(start);
        } else {
          // Head-first: opportunistically probe size so the UI can show
          // a progress indicator (and so the next-chunk logic in the
          // scroll handler knows when to stop).
          if (typeof size !== 'number' && total == null) {
            const t = await probeSize();
            if (!cancelled && t != null) setTotal(t);
          }
          await fetchChunk(0);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    source,
    project_id,
    conversation_id,
    path,
    tailFirst,
    fetchChunk,
    probeSize,
    size,
    total,
  ]);

  // Scroll-driven lazy load. We attach a passive scroll listener to the
  // scrolling container; when the user approaches the head (head-first) or
  // the tail (tail-first), fire one chunk fetch. The `loadingRef` guard
  // means a request that is in flight suppresses duplicates.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loadingRef.current) return;
      if (total == null) return;
      // Need more forward content: user is near the bottom. Offsets are
      // bytes, so advance by the server-reported chunk length.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < CHUNK_SIZE) {
        const last = chunks[chunks.length - 1];
        if (!last) return;
        const next = last.offset + last.length;
        if (next < total) {
          void fetchChunk(next);
        }
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [chunks, total, fetchChunk]);

  if (loading && chunks.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-destructive p-4">
        Could not load file: {error}
      </div>
    );
  }

  // Concatenate chunk bodies; each chunk is rendered as its own <pre> so
  // the browser's own scrollbar works on the union. Tabs/spaces are
  // preserved verbatim and word-wrap stays on for log readability.
  const shownBytes = chunks.reduce((n, c) => n + c.length, 0);
  const pct = total
    ? Math.min(100, Math.round((shownBytes / total) * 100))
    : null;
  return (
    <div className="h-full w-full flex flex-col">
      {!embedded && (
        <FilePreviewHeader
          label={path ?? title}
          mimetype={mimetype}
          meta={
            <>
              {total != null && <span>{formatBytes(total)}</span>}
              {pct != null && pct < 100 && <span>· loaded {pct}%</span>}
            </>
          }
        />
      )}
      <div
        ref={containerRef}
        data-ui="text-preview-chunked-scroll"
        className="flex-1 min-h-0 overflow-auto"
      >
        {chunks.map((c) => (
          <pre
            key={c.offset}
            className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words px-3 py-1 m-0"
          >
            {c.text}
          </pre>
        ))}
        {total != null &&
          chunks.length > 0 &&
          (() => {
            const last = chunks[chunks.length - 1];
            return last.offset + last.length < total ? (
              <div className="text-[11px] text-muted-foreground text-center py-1 border-t border-border/30">
                ↓ scroll down to load more
              </div>
            ) : null;
          })()}
      </div>
    </div>
  );
}

/**
 * Routes a tab to the right renderer based on mimetype. Falls back to the
 * download card when mimetype is unknown. Tabs without a resolvable `source`
 * URL render a small empty state (e.g. when opened in a context that hasn't
 * supplied a fetch URL yet).
 *
 * For text-like files we use the chunked renderer when:
 *   - the tab carries a `size` >= CHUNKED_PREVIEW_THRESHOLD, OR
 *   - a HEAD probe returns a Content-Length >= CHUNKED_PREVIEW_THRESHOLD.
 * That decision is made here so `TextPreview` itself can stay a simple
 * "fetch the whole thing" renderer used for the small-file path.
 */
function EditableTextPreview({
  tab,
  projectId,
  identity,
  markdown,
  view,
}: {
  tab: PreviewTab;
  projectId: string;
  identity: { source: LocalEditableSource; path: string };
  markdown: boolean;
  view: React.ReactNode;
}) {
  const user = useAuth((state) => state.user);
  const { data: project } = useProject(projectId);
  const queryClient = useQueryClient();
  const allowed =
    user?.role === 'admin' ||
    (!!user &&
      (project?.userId === user.id || project?.accessLevel === 'owner'));
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [revision, setRevision] = useState('');
  const [savedText, setSavedText] = useState('');
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [markdownMode, setMarkdownMode] = useState<
    'edit' | 'preview' | 'split'
  >('edit');
  const [position, setPosition] = useState('Ln 1, Col 1');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [dictating, setDictating] = useState(false);
  const desktopMarkdown = useMediaQuery('(min-width: 768px)');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef('');
  const effectiveMarkdownMode =
    markdownMode === 'split' && !desktopMarkdown ? 'edit' : markdownMode;
  const textareaAvailable =
    revealed && (!markdown || effectiveMarkdownMode !== 'preview');

  const insertDictation = useCallback(
    (phrase: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const next = insertTextAtTextareaSelection(textarea, phrase);
      draftRef.current = next;
      setDirty(next !== savedText);
      if (markdown) setMarkdownDraft(next);
      requestAnimationFrame(() => {
        textarea.focus();
      });
    },
    [markdown, savedText],
  );
  const voice = useLiveVoice(
    dictating && editing && textareaAvailable,
    insertDictation,
    { useAccountDictationLanguage: true },
  );
  useDictationFailureToast(voice);

  useEffect(() => {
    if (markdown && markdownMode === 'split' && !desktopMarkdown)
      setMarkdownMode('edit');
  }, [desktopMarkdown, markdown, markdownMode]);

  useEffect(() => {
    if (!textareaAvailable) setDictating(false);
  }, [textareaAvailable]);

  const updatePosition = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const coordinate = (index: number) => {
      const before = textarea.value.slice(0, index);
      return {
        line: before.split('\n').length,
        column: index - before.lastIndexOf('\n'),
      };
    };
    const from = coordinate(start);
    const contextKey = `${projectId}:${tab.id}`;
    if (end === start) {
      setPosition(`Ln ${from.line}, Col ${from.column}`);
      updateOpenFileContext(contextKey, {
        line: from.line,
        column: from.column,
        selection: undefined,
        revision: revision || undefined,
        unsavedChanges: dirty,
      });
      return;
    }
    const to = coordinate(end);
    setPosition(
      `Ln ${from.line}, Col ${from.column} – Ln ${to.line}, Col ${to.column}`,
    );
    updateOpenFileContext(contextKey, {
      line: from.line,
      column: from.column,
      selection: { start: from, end: to },
      revision: revision || undefined,
      unsavedChanges: dirty,
    });
  }, [dirty, projectId, revision, tab.id]);

  useEffect(() => {
    updateOpenFileContext(`${projectId}:${tab.id}`, {
      revision: revision || undefined,
      unsavedChanges: dirty,
    });
  }, [dirty, projectId, revision, tab.id]);

  useEffect(() => {
    const key = `${projectId}:${tab.id}`;
    if (!editing || (sensitive && !revealed)) {
      updateOpenFileContext(key, {
        line: undefined,
        column: undefined,
        selection: undefined,
      });
      return;
    }
    // Preview-only Markdown deliberately retains the last editor position.
    if (!textareaAvailable) return;
    requestAnimationFrame(updatePosition);
  }, [
    editing,
    projectId,
    revealed,
    sensitive,
    tab.id,
    textareaAvailable,
    updatePosition,
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConflict(false);
    try {
      const file = await loadEditableFile(
        projectId,
        identity.source,
        identity.path,
      );
      setRevision(file.revision);
      setSavedText(file.content);
      setSensitive(file.sensitive);
      setRevealed(!file.sensitive);
      setMarkdownDraft(file.content);
      draftRef.current = file.content;
      setDirty(false);
      setEditing(true);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.value = file.content;
          textareaRef.current.setSelectionRange(0, 0);
          updateOpenFileContext(`${projectId}:${tab.id}`, {
            line: 1,
            column: 1,
            selection: undefined,
            revision: file.revision,
            unsavedChanges: false,
          });
        }
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [identity.path, identity.source, projectId, tab.id]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    const submittedText = draftRef.current;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const result = await saveEditableFile(projectId, {
        ...identity,
        content: submittedText,
        expectedRevision: revision,
      });
      setRevision(result.revision);
      setSavedText(submittedText);
      setDirty(draftRef.current !== submittedText);
      if (identity.source === 'artifact') {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.artifacts.all(projectId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.artifacts.explorer(projectId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.artifacts.search(projectId),
          }),
        ]);
      } else
        await queryClient.invalidateQueries({
          queryKey: queryKeys.groupFiles.all(projectId),
        });
    } catch (cause) {
      if (cause instanceof EditableFileConflictError) setConflict(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [dirty, identity, projectId, queryClient, revision, saving]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // One discard prompt at a time: a repeated gesture shares the open dialog.
  const discardPromptRef = useRef<Promise<boolean> | null>(null);
  const confirmDiscard = useCallback(
    (message: string, options: ConfirmOptions) => {
      if (discardPromptRef.current) return discardPromptRef.current;
      const prompt = confirmAction(message, {
        ...options,
        confirmLabel: 'Discard',
        destructive: true,
      }).finally(() => {
        discardPromptRef.current = null;
      });
      discardPromptRef.current = prompt;
      return prompt;
    },
    [],
  );
  const confirmDiscardChanges = useCallback(
    () =>
      confirmDiscard('Discard unsaved file changes?', {
        title: 'Discard unsaved file changes?',
      }),
    [confirmDiscard],
  );
  useEffect(
    () =>
      registerPreviewTabLeaveGuard(
        projectId,
        tab.id,
        () => !dirty || confirmDiscardChanges(),
      ),
    [confirmDiscardChanges, dirty, projectId, tab.id],
  );
  useEffect(() => () => voice.stop(), [identity.path]);

  if (!allowed || !editing) {
    // The Edit action is handed to the view's header instead of overlaying
    // it, so it never covers header text or view controls.
    const editAction = allowed ? (
      <Button
        type="button"
        onClick={() => void load()}
        disabled={loading}
        aria-label="Edit file"
        title="Edit file"
        size="icon-xs"
        variant="ghost"
        data-ui="file-editor-edit"
        data-source={identity.source}
        data-path={identity.path}
      >
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Pencil className="size-3" />
        )}
      </Button>
    ) : null;
    return (
      <FilePreviewActionsContext.Provider value={editAction}>
        <div className="relative h-full w-full">
          {view}
          {error && (
            <div className="absolute bottom-2 left-2 right-2 rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground">
              {error}
            </div>
          )}
        </div>
      </FilePreviewActionsContext.Provider>
    );
  }

  const cancel = async () => {
    if (dirty && !(await confirmDiscardChanges())) return;
    draftRef.current = savedText;
    setMarkdownDraft(savedText);
    setDirty(false);
    setEditing(false);
    setDictating(false);
    setConflict(false);
  };
  const reload = async () => {
    if (
      dirty &&
      !(await confirmDiscard(
        'Discard this draft and reload the latest saved file?',
        { title: 'Discard draft and reload?' },
      ))
    )
      return;
    await load();
  };
  const copyDraft = async () => {
    await navigator.clipboard.writeText(draftRef.current);
  };
  const showEditor = !markdown || effectiveMarkdownMode !== 'preview';
  const showPreview = markdown && effectiveMarkdownMode !== 'edit';
  return (
    <div
      className="flex h-full flex-col"
      data-ui="file-preview-editor"
      data-source={identity.source}
      data-path={identity.path}
    >
      <div
        className="flex min-w-0 flex-wrap items-center gap-1 border-b px-2 py-1"
        data-ui="file-editor-toolbar"
      >
        <span className="min-w-0 flex-1 truncate text-xs">{tab.path}</span>
        {markdown && (
          <div
            className="flex shrink-0 rounded-md border p-0.5"
            data-ui="file-editor-markdown-modes"
          >
            {(['edit', 'preview', 'split'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                onClick={() => setMarkdownMode(mode)}
                size="icon-xs"
                variant={markdownMode === mode ? 'secondary' : 'ghost'}
                className={mode === 'split' ? 'hidden md:inline-flex' : ''}
                title={`${mode[0]!.toUpperCase() + mode.slice(1)} mode`}
                aria-label={`${mode[0]!.toUpperCase() + mode.slice(1)} mode`}
                aria-pressed={markdownMode === mode}
                data-ui="file-editor-markdown-mode"
                data-mode={mode}
              >
                {mode === 'edit' ? (
                  <Pencil className="size-3" />
                ) : mode === 'preview' ? (
                  <Eye className="size-3" />
                ) : (
                  <Columns2 className="size-3" />
                )}
              </Button>
            ))}
          </div>
        )}
        <Button
          type="button"
          data-ui="file-editor-dictation"
          aria-pressed={dictating}
          aria-label={dictating ? 'Stop dictation' : 'Start dictation'}
          title={dictating ? 'Stop dictation' : 'Start dictation'}
          disabled={!textareaAvailable}
          onClick={() => {
            if (textareaAvailable) setDictating((value) => !value);
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Mic
            className={`size-4 ${dictating ? 'text-red-600 dark:text-red-500' : ''}`}
          />
        </Button>
        <Button
          type="button"
          data-ui="file-editor-save"
          aria-label="Save"
          title="Save"
          onClick={() => void save()}
          disabled={!dirty || saving}
          size="icon-xs"
          variant="ghost"
        >
          {saving ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Save className="size-3" />
          )}
        </Button>
        <Button
          type="button"
          data-ui="file-editor-cancel"
          aria-label="Cancel"
          title="Cancel"
          onClick={() => void cancel()}
          size="icon-xs"
          variant="ghost"
        >
          <X className="size-3" />
        </Button>
      </div>
      <div className="px-2 py-1 text-[11px] text-muted-foreground">
        Saving changes this project-local{' '}
        {identity.source === 'artifact' ? 'Artifact' : 'Group Folder'} file
        directly and does not involve an agent.
      </div>
      {sensitive && !revealed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <p className="text-sm">
            This file may contain credentials or other sensitive values.
          </p>
          <button
            type="button"
            className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm"
            onClick={() => setRevealed(true)}
          >
            <Eye className="size-4" />
            Reveal
          </button>
        </div>
      ) : (
        <div
          className={`grid min-h-0 flex-1 ${effectiveMarkdownMode === 'split' ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {showEditor && (
            <textarea
              ref={textareaRef}
              data-ui="file-editor-cursor"
              defaultValue={draftRef.current}
              aria-label={`Edit ${tab.title}`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="h-full min-h-0 w-full resize-none border-0 bg-background p-3 font-mono text-xs leading-relaxed outline-none"
              onInput={(event) => {
                const value = event.currentTarget.value;
                draftRef.current = value;
                setDirty(value !== savedText);
                if (markdown) setMarkdownDraft(value);
                updatePosition();
              }}
              onClick={updatePosition}
              onKeyUp={updatePosition}
              onSelect={updatePosition}
              onKeyDown={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === 's'
                ) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          )}
          {showPreview && (
            <div
              data-ui="file-editor-markdown-preview"
              className="markdown-output min-h-0 overflow-auto border-l p-4"
            >
              <MarkdownContent>{markdownDraft}</MarkdownContent>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 border-t px-2 py-1 text-[11px] text-muted-foreground">
        <span>{position}</span>
        <span aria-live="polite">
          {voice.status === 'idle' ? '' : voice.status}
          {voice.partial ? `: ${voice.partial}` : ''}
        </span>
        {dirty && <span>Unsaved</span>}
      </div>
      {conflict && (
        <div
          role="alert"
          // Translucent amber fill reads on both themes; only the border tone is theme-swapped.
          className="flex flex-wrap items-center gap-2 border-t border-amber-600 bg-amber-500/10 p-2 text-xs dark:border-amber-500"
        >
          <span className="flex-1">
            This file changed after you opened it. Your draft was not saved.
          </span>
          <button
            type="button"
            className="rounded border px-2 py-1"
            onClick={() => void copyDraft()}
          >
            Copy draft
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1"
            onClick={() => void reload()}
          >
            Reload latest
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="border-t p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

export function ActiveTabContent({
  tab,
  fetchUrl,
  project_id,
  conversation_id,
  sizeProbe,
  sizeProbePending = false,
  isPreviewVisible = true,
}: {
  tab: PreviewTab;
  fetchUrl: string | null;
  project_id: string;
  conversation_id: string | null;
  /** Optional pre-fetched size from the parent's HEAD probe; used to pick
   *  between TextPreview and TextPreviewChunked without an extra round-trip. */
  sizeProbe?: number | null;
  /** True while the parent's HEAD probe for `fetchUrl` is in flight. */
  sizeProbePending?: boolean;
  isPreviewVisible?: boolean;
}) {
  const mimetype = resolveMimetype(tab);

  if (!fetchUrl) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground px-4 text-center">
        No preview available for this file.
      </div>
    );
  }

  if (mimetype.startsWith('image/')) {
    return (
      <MediaPreview
        key={`image:${fetchUrl}`}
        url={fetchUrl}
        title={tab.title}
        mimetype={mimetype}
        size={tab.size ?? sizeProbe}
        kind="image"
        isVisible={isPreviewVisible}
      />
    );
  }
  if (mimetype.startsWith('video/')) {
    return (
      <MediaPreview
        key={`video:${fetchUrl}`}
        url={fetchUrl}
        title={tab.title}
        mimetype={mimetype}
        size={tab.size ?? sizeProbe}
        kind="video"
        isVisible={isPreviewVisible}
      />
    );
  }
  if (mimetype.startsWith('audio/')) {
    return (
      <MediaPreview
        key={`audio:${fetchUrl}`}
        url={fetchUrl}
        title={tab.title}
        mimetype={mimetype}
        size={tab.size ?? sizeProbe}
        kind="audio"
        isVisible={isPreviewVisible}
      />
    );
  }
  if (mimetype === 'application/pdf') {
    return (
      <PdfPreview
        url={fetchUrl}
        title={tab.title}
        size={tab.size ?? sizeProbe}
      />
    );
  }
  const editableIdentity = editableTabIdentity(tab);
  const editableSize = typeof tab.size === 'number' ? tab.size : sizeProbe;
  const locallyEditable =
    !!editableIdentity &&
    (editableSize == null || editableSize <= TEXT_PREVIEW_MAX_BYTES) &&
    !(
      editableIdentity.source === 'group' &&
      /^(logs|transcripts)(\/|$)/.test(editableIdentity.path)
    );
  if (MARKDOWN_MIMES.has(mimetype)) {
    // Markdown still goes through the text fetcher so we render the same
    // MarkdownContent component the rest of the app uses. We deliberately
    // *don't* chunk markdown: chunked reads would break the parser, and
    // the regular `TextPreview`'s 500 KiB cap already protects us from
    // pathological inputs.
    const view = (
      <MarkdownTextPreview
        url={fetchUrl}
        title={tab.title}
        path={tab.path}
        mimetype={mimetype}
        fallbackText={tab.fallbackContent}
      />
    );
    return locallyEditable ? (
      <EditableTextPreview
        key={`${project_id}:${editableIdentity.source}:${editableIdentity.path}`}
        tab={tab}
        projectId={project_id}
        identity={editableIdentity}
        markdown
        view={view}
      />
    ) : (
      view
    );
  }
  if (isLikelyText(mimetype)) {
    // Decide chunked vs single-shot. We need `source` (so the chunked
    // renderer knows which content endpoint to call) and a size signal to
    // pick the path. tab.size is set by the store at file-open time when
    // the parent already has the stat; sizeProbe is the result of a HEAD
    // the parent may have just done. If we don't have a number we still
    // route to the chunked renderer — it HEAD-probes internally — so the
    // decision is mostly about avoiding the HEAD round-trip when we
    // already know the answer.
    const sizeHint = typeof tab.size === 'number' ? tab.size : sizeProbe;
    // Wait for the parent's probe instead of mounting the chunked viewer
    // and replacing it once the size arrives — each mount fetches the file.
    if (sizeHint == null && sizeProbePending) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      );
    }
    const source: 'group' | 'repo' | 'mount' | 'root' | null =
      tab.source === 'group' ||
      tab.source === 'repo' ||
      tab.source === 'mount' ||
      tab.source === 'root'
        ? tab.source
        : null;
    const overThreshold =
      typeof sizeHint === 'number' && sizeHint > CHUNKED_PREVIEW_THRESHOLD;
    const jsonKind = jsonKindForPath(tab.path ?? tab.title);
    let view: React.ReactNode;
    if (
      jsonKind === 'lines' &&
      source &&
      tab.path &&
      (overThreshold || sizeHint == null)
    ) {
      view = (
        <JsonLinesChunkedPreview
          key={`jsonl:${fetchUrl}`}
          source={source}
          mountSlot={tab.mountSlot}
          rootIndex={tab.rootIndex}
          project_id={project_id}
          conversation_id={tab.conversation_id ?? conversation_id}
          path={tab.path}
          title={tab.title}
          mimetype={mimetype}
          size={sizeHint}
        />
      );
    } else if (jsonKind === 'lines') {
      view = (
        <JsonLinesPreview
          url={fetchUrl}
          title={tab.title}
          path={tab.path}
          mimetype={mimetype}
        />
      );
    } else if (
      jsonKind === 'document' &&
      (sizeHint != null
        ? sizeHint <= TEXT_PREVIEW_MAX_BYTES
        : !(source && tab.path))
    ) {
      view = (
        <JsonDocumentPreview
          url={fetchUrl}
          title={tab.title}
          path={tab.path}
          mimetype={mimetype}
          hljsLang={resolveHljsLang(tab)}
        />
      );
    } else if (source && tab.path && (overThreshold || sizeHint == null)) {
      view = (
        <TextPreviewChunked
          source={source}
          mountSlot={tab.mountSlot}
          rootIndex={tab.rootIndex}
          project_id={project_id}
          // Use the tab's pinned conversation for repo reads so chunked
          // fetches stay stable across active-conversation switches — same
          // rationale as resolveTabFetchUrl's repo branch.
          conversation_id={tab.conversation_id ?? conversation_id}
          path={tab.path}
          title={tab.title}
          mimetype={mimetype}
          size={sizeHint}
        />
      );
    } else
      view = (
        <TextPreview
          url={fetchUrl}
          title={tab.title}
          path={tab.path}
          mimetype={mimetype}
          hljsLang={resolveHljsLang(tab)}
        />
      );
    const sourceView = locallyEditable ? (
      <EditableTextPreview
        key={`${project_id}:${editableIdentity.source}:${editableIdentity.path}`}
        tab={tab}
        projectId={project_id}
        identity={editableIdentity}
        markdown={false}
        view={view}
      />
    ) : (
      view
    );
    // HTML opens rendered (sandboxed iframe) with a Source toggle; files known
    // to exceed the preview cap open straight in Source — never chunk-render
    // into the iframe.
    if (
      mimetype === 'text/html' &&
      !(typeof sizeHint === 'number' && sizeHint > TEXT_PREVIEW_MAX_BYTES)
    ) {
      return (
        <HtmlPreviewWithSource
          key={`html:${tab.id}`}
          url={fetchUrl}
          title={tab.title}
          mimetype={mimetype}
          fallbackText={tab.fallbackContent}
          source={sourceView}
        />
      );
    }
    return sourceView;
  }
  return (
    <BinaryDownloadPreview
      url={fetchUrl}
      title={tab.title}
      mimetype={mimetype}
      size={tab.size ?? sizeProbe}
    />
  );
}

/**
 * Loads a text file under the {@link TEXT_PREVIEW_MAX_BYTES} cap (HEAD size
 * probe, `fallbackText` on 404, download card when too large) and hands the
 * body to `children`. Shared by the Markdown and sandboxed HTML previews,
 * which both need the whole body in memory.
 */
function BoundedTextPreview({
  url,
  title,
  mimetype,
  fallbackText,
  children,
}: {
  url: string;
  title: string;
  mimetype: string;
  fallbackText?: string;
  children: (text: string) => React.ReactNode;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tooLarge, setTooLarge] = useState<{ size: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    setTooLarge(null);
    (async () => {
      try {
        let probedSize: number | null = null;
        try {
          const headRes = await apiFetch(url, { method: 'HEAD' });
          if (headRes.ok) {
            const len = headRes.headers.get('Content-Length');
            if (len && /^\d+$/.test(len)) probedSize = Number(len);
          }
        } catch {
          // HEAD unavailable — fall through to GET.
        }
        if (probedSize != null && probedSize > TEXT_PREVIEW_MAX_BYTES) {
          if (!cancelled) setTooLarge({ size: probedSize });
          return;
        }
        const res = await apiFetch(url);
        let body: string;
        if (res.ok) {
          body = await readPreviewText(res, url);
        } else if (res.status === 404 && fallbackText != null) {
          body = fallbackText;
        } else {
          throw new Error(`Failed to load file (${res.status})`);
        }
        if (cancelled) return;
        if (body.length > TEXT_PREVIEW_MAX_BYTES) {
          // Match the cap check's unit (UTF-16 code units) — see the
          // TextPreview fallback above for the same reasoning.
          setTooLarge({ size: body.length });
          return;
        }
        setText(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fallbackText, url]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="size-3.5 animate-spin" /> Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-xs text-destructive p-4">
        Could not load file: {error}
      </div>
    );
  }
  if (tooLarge) {
    return (
      <BinaryDownloadPreview
        url={url}
        title={title}
        mimetype={mimetype}
        size={tooLarge.size}
        reason={`File too large to preview (${formatBytes(tooLarge.size)} > ${formatBytes(TEXT_PREVIEW_MAX_BYTES)})`}
      />
    );
  }
  return <>{children(text ?? '')}</>;
}

/**
 * Markdown is text under the hood but we want the rendered tree, not raw
 * monospace. Loads the file as text and hands it to <MarkdownContent>.
 *
 * Same size cap as {@link TextPreview} — markdown that builds into a giant
 * react tree is just as capable of locking up the tab.
 */
function MarkdownTextPreview({
  url,
  title,
  path,
  mimetype,
  fallbackText,
}: {
  url: string;
  title: string;
  path?: string;
  mimetype: string;
  fallbackText?: string;
}) {
  return (
    <BoundedTextPreview
      url={url}
      title={title}
      mimetype={mimetype}
      fallbackText={fallbackText}
    >
      {(text) => (
        <div className="flex h-full w-full flex-col">
          <FilePreviewHeader label={path ?? title} mimetype={mimetype} />
          {/*
           * `markdown-output` is the same wrapper class the chat bubbles use; it
           * matches the global styles in ui/src/global.css (table styling, code
           * blocks) so a markdown file opened in the preview pane looks
           * consistent with the same content rendered in a chat bubble. The
           * `#file-preview-markdown` id additionally scopes the full-document
           * heading treatment (sized h1/h2 with border-bottom) to this pane
           * only — chat bubbles use `markdown-output--inline` and task chats use
           * bare `markdown-output`, neither of which should pick up the
           * prominent heading styling.
           */}
          <div
            id="file-preview-markdown"
            className="markdown-output min-h-0 w-full flex-1 overflow-auto p-4"
          >
            <MarkdownContent>{text}</MarkdownContent>
          </div>
        </div>
      )}
    </BoundedTextPreview>
  );
}

/**
 * Renders an HTML file inside a sandboxed iframe. The body is agent- or
 * outsider-written, so it must never share the board origin: `sandbox` is
 * exactly `allow-scripts` (no `allow-same-origin`, top navigation, popups,
 * modals or forms) and the body goes in via `srcDoc` — never into the parent
 * DOM and never through a same-origin blob:/data: URL. Relative assets next to
 * the file do not resolve under `srcDoc`.
 */
function HtmlPreview({
  url,
  title,
  mimetype,
  fallbackText,
}: {
  url: string;
  title: string;
  mimetype: string;
  fallbackText?: string;
}) {
  return (
    <BoundedTextPreview
      url={url}
      title={title}
      mimetype={mimetype}
      fallbackText={fallbackText}
    >
      {(text) => (
        <iframe
          data-ui="html-preview-frame"
          srcDoc={text}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={title}
          // bg-white stays in both themes: the sandboxed HTML preview renders
          // arbitrary pages that expect a white document background.
          className="h-full w-full border-0 bg-white"
        />
      )}
    </BoundedTextPreview>
  );
}

/**
 * Preview / Source toggle for HTML files. Preview (sandboxed iframe) is the
 * default. Source is the regular text path, including chunked rendering and
 * editing, and stays mounted once opened so an unsaved edit survives toggling.
 */
function HtmlPreviewWithSource({
  url,
  title,
  mimetype,
  fallbackText,
  source,
}: {
  url: string;
  title: string;
  mimetype: string;
  fallbackText?: string;
  source: React.ReactNode;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [sourceOpened, setSourceOpened] = useState(false);
  const select = (next: 'preview' | 'source') => {
    if (next === 'source') setSourceOpened(true);
    setMode(next);
  };
  return (
    <div className="flex h-full w-full flex-col" data-ui="html-preview">
      <div
        className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
        data-ui="html-preview-modes"
      >
        <div className="flex shrink-0 rounded-md border p-0.5">
          {(['preview', 'source'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              onClick={() => select(value)}
              size="xs"
              variant={mode === value ? 'secondary' : 'ghost'}
              aria-pressed={mode === value}
              data-ui="html-preview-mode"
              data-mode={value}
            >
              {value === 'preview' ? 'Preview' : 'Source'}
            </Button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {mode === 'preview' && (
          <HtmlPreview
            url={url}
            title={title}
            mimetype={mimetype}
            fallbackText={fallbackText}
          />
        )}
        {sourceOpened && (
          <div className={mode === 'source' ? 'h-full w-full' : 'hidden'}>
            {source}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Right-side preview pane. Renders an open set of file-preview tabs in the
 * project, or — when no tabs are open — falls back to the existing
 * ConversationExplorer (Artifacts/Changes/Files).
 *
 * Tabs are managed by the UI store (`previewTabsByProject`), so this component
 * is purely a renderer: it reads state and dispatches close/activate.
 *
 * When at least one file tab is open, the Changes/Files tablist
 * stays visible (it now lives alongside the file tab strip, not hidden
 * behind it) so the user can open a second file without first closing
 * the first one. Clicking a conversation tab (Files/Changes)
 * swaps the body for the file tree / changes while the
 * preview tab strip stays visible as breadcrumbs; clicking a preview tab
 * (or opening a new file from the tree) swaps the body back to the
 * active preview. This is achieved by composing with the supplied workspace
 * explorer (or the normal ConversationExplorer) via controlled view props.
 */
export interface WorkspaceExplorerRenderProps {
  onClose?: () => void;
  onFileOpen?: () => void;
  previewStrip?: ReactNode;
  previewBody?: ReactNode;
  tabValue: string;
  onTabValueChange: (value: string) => void;
  onAnnotationSubmitted?: (submission: BrowserAnnotationSubmission) => void;
}

export function PreviewPane({
  project_id,
  conversation_id,
  taskId,
  onClose,
  onFileOpen,
  onAnnotationSubmitted,
  onProjectSetup,
  workspaceViewScope = 'project',
  localDefaultView,
  renderWorkspaceExplorer,
}: {
  project_id: string;
  conversation_id: string | null;
  taskId?: string | null;
  onClose?: () => void;
  onFileOpen?: () => void;
  onAnnotationSubmitted?: (submission: BrowserAnnotationSubmission) => void;
  onProjectSetup?: () => void;
  /**
   * Project-scoped selection belongs to the shared Chat/Kanban workspace.
   * Objective mode has its own tab surface and must always enter an open-file
   * preview without inheriting the normal Chat/Kanban selection.
   */
  workspaceViewScope?: 'project' | 'local';
  /** Objective mode keeps its extra selections local instead of storing them in shared Chat/Kanban state. */
  localDefaultView?: string;
  renderWorkspaceExplorer?: (props: WorkspaceExplorerRenderProps) => ReactNode;
}) {
  const tabsState = useStore((s) => s.previewTabsByProject[project_id]);
  const closePreviewTab = useStore((s) => s.closePreviewTab);
  const updatePreviewTab = useStore((s) => s.updatePreviewTab);
  const setActivePreviewTab = useStore((s) => s.setActivePreviewTab);
  const projectWorkspaceView = useStore(
    (s) => s.workspaceViewByProject[project_id],
  );
  const selectedWorkspaceView =
    workspaceViewScope === 'project' ? projectWorkspaceView : undefined;
  const setWorkspaceView = useStore((s) => s.setWorkspaceViewForProject);
  const consumePendingPreviewActivation = useStore(
    (s) => s.consumePendingPreviewActivation,
  );

  const tabs = tabsState?.tabs ?? [];
  const activeTabId = tabsState?.activeTabId ?? null;
  const activationSequence = tabsState?.activationSequence ?? 0;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isAndroid =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const openFileContextKey = activeTab ? `${project_id}:${activeTab.id}` : null;
  const [localWorkspaceView, setLocalWorkspaceView] = useState<string>(() =>
    projectWorkspaceView === 'browser'
      ? 'browser'
      : localDefaultView === undefined && tabs.length > 0
        ? 'preview'
        : (localDefaultView ?? 'files'),
  );

  // The conversation tablist doubles as a body-swap control: clicking
  // 'preview' shows the file preview, clicking 'files' shows the file
  // tree, etc. The selected view is project-scoped so route remounts do not
  // reset it while switching between Chat and Kanban.
  const tabValue =
    selectedWorkspaceView ??
    (workspaceViewScope === 'local'
      ? localWorkspaceView
      : tabs.length > 0
        ? 'preview'
        : 'files');
  const previousExplorerViewRef = useRef<string>(
    tabValue === 'preview' ? (localDefaultView ?? 'files') : tabValue,
  );
  const setSelectedWorkspaceView = useCallback(
    (view: string) => {
      if (workspaceViewScope === 'project') {
        setWorkspaceView(project_id, view as ConversationTabValue);
      } else {
        // Browser is the one project-owned objective tab: carrying this
        // selection across the mode boundary keeps the main-workspace viewer
        // mounted. Other objective-only tabs remain local as before. Mail is
        // also local: leaving Browser for Mail keeps the Chat/Kanban selection.
        if (view === 'browser') {
          setWorkspaceView(project_id, 'browser');
        } else if (
          view !== 'mail' &&
          localWorkspaceView === 'browser' &&
          projectWorkspaceView === 'browser'
        ) {
          setWorkspaceView(project_id, 'files');
        }
        setLocalWorkspaceView(view);
      }
    },
    [
      localWorkspaceView,
      project_id,
      projectWorkspaceView,
      setWorkspaceView,
      workspaceViewScope,
    ],
  );
  useEffect(() => {
    // openPreviewTab can run before this route mounts (for example, an
    // artifact link opens a tab and then reveals a previously hidden pane).
    // The tab snapshot alone cannot distinguish that explicit activation from
    // tabs restored by a Chat/Kanban route switch, so consume the separate
    // store marker and perform the same jump to Preview here.
    if (!consumePendingPreviewActivation(project_id)) return;
    setSelectedWorkspaceView('preview');
  }, [consumePendingPreviewActivation, project_id, setSelectedWorkspaceView]);
  const lifecycleProjectIdRef = useRef(project_id);
  const prevActiveTabIdRef = useRef<string | null>(activeTabId);
  const prevActivationSequenceRef = useRef(activationSequence);
  const hadTabsRef = useRef<boolean>(tabs.length > 0);
  useEffect(() => {
    // Preview tabs and the selected view are project-scoped. A pane can stay
    // mounted while its route changes project, so don't interpret the new
    // project's existing tab snapshot as an activation in the old project.
    // Otherwise entering a project with tabs can overwrite its saved Files /
    // Changes / Bash selection with Preview.
    if (lifecycleProjectIdRef.current !== project_id) {
      lifecycleProjectIdRef.current = project_id;
      prevActiveTabIdRef.current = activeTabId;
      prevActivationSequenceRef.current = activationSequence;
      hadTabsRef.current = tabs.length > 0;
      return;
    }
    const hadTabs = hadTabsRef.current;
    const hasTabsNow = tabs.length > 0;
    const explicitlyOpened =
      prevActivationSequenceRef.current !== activationSequence;
    if (explicitlyOpened) {
      // A file can be opened while this pane is already mounted. Consume the
      // marker here as well as on mount; otherwise it survives until the next
      // route remount and incorrectly re-selects Preview after the user has
      // chosen Files, Changes, or Bash.
      consumePendingPreviewActivation(project_id);
    }
    if (tabValue !== 'preview') {
      previousExplorerViewRef.current = tabValue;
    }
    if (!hadTabs && hasTabsNow) {
      // First tab just opened: jump the body to the preview so the user
      // sees their file immediately.
      setSelectedWorkspaceView('preview');
    } else if (hadTabs && !hasTabsNow) {
      // Last tab just closed: return to the explorer tab that was active
      // before the preview opened.
      setSelectedWorkspaceView(previousExplorerViewRef.current);
    } else if (
      hasTabsNow &&
      (explicitlyOpened ||
        (prevActiveTabIdRef.current !== activeTabId &&
          // A tab that was renamed, moved or deleted from the Files list
          // changes the active id without the user picking a file.
          !(
            prevActiveTabIdRef.current &&
            !tabs.some((tab) => tab.id === prevActiveTabIdRef.current)
          )))
    ) {
      // Active preview tab changed (user clicked a different preview tab
      // OR a new file opened from the file tree). Snap back to the
      // preview body so the user sees the file they just picked.
      setSelectedWorkspaceView('preview');
    }
    prevActiveTabIdRef.current = activeTabId;
    prevActivationSequenceRef.current = activationSequence;
    hadTabsRef.current = hasTabsNow;
  }, [
    activeTabId,
    activationSequence,
    project_id,
    consumePendingPreviewActivation,
    localDefaultView,
    setSelectedWorkspaceView,
    tabValue,
    tabs,
    workspaceViewScope,
  ]);

  useEffect(() => {
    const context = visiblePreviewTabOpenFileContext(
      activeTab,
      tabValue === 'preview',
      conversation_id,
    );
    if (!context) {
      publishOpenFileContext(null);
      return;
    }
    publishOpenFileContext({
      key: openFileContextKey!,
      conversationId: conversation_id,
      context,
    });
    return () => {
      if (openFileContextKey) publishOpenFileContext(null);
    };
  }, [activeTab, conversation_id, openFileContextKey, project_id, tabValue]);

  // Resolve the active tab's fetch URL up front so we can HEAD-probe its
  // size before choosing a renderer. The probe matters: `ActiveTabContent`
  // picks between `TextPreview` (single-shot fetch + highlight.js syntax
  // highlighting) and `TextPreviewChunked` (incremental, no highlighting)
  // based on size. `files-tab.tsx` opens tabs without a `size` field, so
  // without a probe here `sizeHint` is null and EVERY file — including
  // tiny ones like `.mcp.json` — falls into the chunked renderer and never
  // gets syntax highlighting. Probing once at this level routes small
  // files to the highlighted path and reserves chunked loading for
  // genuinely large files.
  const fetchUrl = activeTab
    ? resolveTabFetchUrl(activeTab, project_id, conversation_id)
    : null;
  // Keyed by URL so a tab switch reads as "pending" on the very first
  // render, before the effect below has run.
  const [sizeProbeResult, setSizeProbeResult] = useState<{
    url: string;
    size: number | null;
  } | null>(null);
  const sizeProbePending = !!fetchUrl && sizeProbeResult?.url !== fetchUrl;
  const sizeProbe = sizeProbePending ? null : (sizeProbeResult?.size ?? null);
  useEffect(() => {
    if (!fetchUrl) {
      setSizeProbeResult(null);
      return;
    }
    let cancelled = false;
    const finish = (size: number | null) => {
      if (!cancelled) setSizeProbeResult({ url: fetchUrl, size });
    };
    (async () => {
      try {
        const res = await apiFetch(fetchUrl, { method: 'HEAD' });
        const len = res.ok ? res.headers.get('Content-Length') : null;
        finish(len && /^\d+$/.test(len) ? Number(len) : null);
      } catch {
        finish(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchUrl]);

  // Drag a text selection out of the preview body into the chat input. The
  // browser initiates a native drag of the selected text; we piggyback on
  // `dragstart` (which bubbles up to the body wrapper) to attach a payload
  // that the chat drop target turns into `@<path> (lines a-b)` + a fenced
  // code block. Line numbers are only computed when the selection sits
  // inside a `<pre data-file-lines>` (the full-file TextPreview renderer);
  // for rendered markdown / chunked views they're null.
  //
  // This hook MUST be declared before the `tabs.length === 0` early return
  // below — React requires the same hook count on every render, and tabs
  // transition from 0 → >0 when a file is opened. Declaring a hook after the
  // early return flips the hook count and throws "Rendered more hooks than
  // during the previous render" (minified React error #310).
  const handlePreviewDragStart = useCallback(
    (e: React.DragEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      // Only act on selections that actually live inside this preview body —
      // a stale selection made elsewhere (e.g. the chat) shouldn't be turned
      // into a preview payload when the user drags something else here.
      const root = e.currentTarget as HTMLElement;
      if (!sel.anchorNode || !root.contains(sel.anchorNode)) return;
      const text = sel.toString();
      if (!text) return;
      const lines = selectionLineRange(root, sel);
      const payload: PreviewSelectionPayload = {
        path: activeTab?.path,
        text,
        startLine: lines?.start ?? null,
        endLine: lines?.end ?? null,
      };
      e.dataTransfer.setData(
        PREVIEW_SELECTION_DRAG_TYPE,
        JSON.stringify(payload),
      );
      e.dataTransfer.effectAllowed = 'copy';
    },
    [activeTab?.path],
  );

  const handlePreviewPosition = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!openFileContextKey) return;
      const root = event.currentTarget;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const startPre =
          range.startContainer.parentElement?.closest<HTMLElement>(
            '[data-file-lines]',
          );
        const endPre =
          range.endContainer.parentElement?.closest<HTMLElement>(
            '[data-file-lines]',
          );
        if (startPre && startPre === endPre && root.contains(startPre)) {
          const start = sourcePosition(
            startPre,
            range.startContainer,
            range.startOffset,
          );
          const end = sourcePosition(
            startPre,
            range.endContainer,
            range.endOffset,
          );
          updateOpenFileContext(openFileContextKey, {
            line: start.line,
            column: start.column,
            selection: { start, end },
          });
        }
        return;
      }
      const doc = document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
      const range = caret
        ? null
        : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = caret?.offsetNode ?? range?.startContainer;
      const offset = caret?.offset ?? range?.startOffset;
      const pre =
        node?.parentElement?.closest<HTMLElement>('[data-file-lines]');
      if (!node || offset === undefined || !pre || !root.contains(pre)) return;
      const point = sourcePosition(pre, node, offset);
      updateOpenFileContext(openFileContextKey, {
        line: point.line,
        column: point.column,
        selection: undefined,
      });
    },
    [openFileContextKey],
  );

  const availableTabValue =
    (!renderWorkspaceExplorer && isAndroid && tabValue === 'bash') ||
    (tabValue === 'preview' && tabs.length === 0)
      ? (localDefaultView ?? 'files')
      : tabValue;
  const handleTabValueChange = (value: string) => {
    // Nothing to leave: switch immediately instead of awaiting a guard.
    if (value === 'preview' || !activeTabId) {
      setSelectedWorkspaceView(value);
      return;
    }
    void canLeavePreviewTab(project_id, activeTabId).then((allowed) => {
      if (allowed) setSelectedWorkspaceView(value);
    });
  };

  const renderExplorer = (props: WorkspaceExplorerRenderProps) =>
    renderWorkspaceExplorer ? (
      renderWorkspaceExplorer(props)
    ) : (
      <ConversationExplorer
        project_id={project_id}
        conversation_id={conversation_id}
        taskId={taskId}
        {...props}
        tabValue={props.tabValue as ConversationTabValue}
        onTabValueChange={(value) => props.onTabValueChange(value)}
        onAnnotationSubmitted={onAnnotationSubmitted}
        onProjectSetup={onProjectSetup}
      />
    );

  // No tabs open → use the project-scoped explorer selection. The explorer's
  // own `onClose` prop wires the panel's hide button.
  if (tabs.length === 0) {
    return renderExplorer({
      ...(onClose ? { onClose } : {}),
      ...(onFileOpen ? { onFileOpen } : {}),
      ...(onAnnotationSubmitted ? { onAnnotationSubmitted } : {}),
      tabValue: availableTabValue,
      onTabValueChange: handleTabValueChange,
    });
  }

  const strip = (
    <PreviewTabStrip
      tabs={tabs}
      activeTabId={activeTabId}
      onActivate={async (id) => {
        // Activate the tab in the store and switch the body to the
        // preview in one go. The effect below would also fire on
        // activeTabId changes, but doing both here means re-clicking the
        // already-active tab (a no-op for the store) still re-focuses
        // the preview body — the user expects "click this tab → see
        // this file's preview", full stop.
        //
        // A cancelled leave prompt leaves the active tab and the selected
        // workspace view untouched.
        if (!(await setActivePreviewTab(project_id, id))) return;
        updatePreviewTab(project_id, id, {
          openFileContextConversationId: conversation_id,
        });
        setSelectedWorkspaceView('preview');
      }}
      onClose={async (id) => {
        const canLeave = await canLeavePreviewTab(project_id, id);
        if (!canLeave) return;
        // Closing a file only closes its tab; the workspace pane (and the
        // folder open in Files) stays put, including on mobile.
        closePreviewTab(project_id, id, true);
      }}
      isPreviewActive={tabValue === 'preview'}
    />
  );

  // Build the preview body once per render. When `activeTab` is missing
  // (transient edge case during store transitions) show a hint rather
  // than flashing the explorer content under the strip.
  //
  // The wrapper uses `h-full overflow-hidden` (not `flex-1 min-h-0`)
  // because ConversationExplorer mounts the body inside an
  // `absolute inset-0` positioned container — flex-1 needs a flex parent
  // to compute a height, while `h-full` works against the explicit
  // dimensions the absolute parent provides. The renderers inside
  // (TextPreview, MarkdownTextPreview, ImagePreview, PdfPreview) take
  // `h-full` themselves so their internal scroll containers have a
  // bounded height to scroll against.
  const knowledgeReference = activeTab?.source
    ? parseKnowledgeReference(activeTab.source)
    : null;
  const body = activeTab ? (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      onDragStart={handlePreviewDragStart}
      onMouseUp={handlePreviewPosition}
      data-ui="open-file-preview-body"
    >
      {knowledgeReference && (
        <div
          className="flex shrink-0 justify-end border-b border-border p-1"
          data-ui="knowledge-preview-actions"
        >
          <KnowledgeInsertButton reference={knowledgeReference} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ActiveTabContent
          key={`${project_id}:${activeTab.id}`}
          tab={activeTab}
          fetchUrl={fetchUrl}
          project_id={project_id}
          conversation_id={
            activeTab.repoContext === 'main'
              ? null
              : (activeTab.conversation_id ?? conversation_id)
          }
          sizeProbe={sizeProbe}
          sizeProbePending={sizeProbePending}
          isPreviewVisible={tabValue === 'preview'}
        />
      </div>
    </div>
  ) : (
    <div className="h-full w-full overflow-hidden flex items-center justify-center text-sm text-muted-foreground px-4 text-center">
      Select a tab to preview its file.
    </div>
  );

  // Keep the Artifacts/Changes/Files tablist visible above the file tab
  // strip so the user can navigate back to the Files tab (and open a
  // second file) without first closing the open one. The conversation
  // tablist is controlled: when `tabValue === 'preview'` the body shows
  // the file preview; otherwise it shows the selected conversation tab
  // (so clicking 'Files' reveals the file tree and clicking a preview
  // tab swaps back to the preview).
  return renderExplorer({
    ...(onClose
      ? {
          onClose: () => {
            void canLeavePreviewTab(project_id, activeTabId).then((allowed) => {
              if (allowed) onClose();
            });
          },
        }
      : {}),
    ...(onFileOpen ? { onFileOpen } : {}),
    previewStrip: strip,
    previewBody: body,
    tabValue: availableTabValue,
    onTabValueChange: handleTabValueChange,
  });
}
