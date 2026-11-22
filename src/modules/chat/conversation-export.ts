/**
 * Static HTML export of one conversation: a zip with `<slug>.html`, one shared
 * `conversation.css` and the referenced images under `images/`.
 *
 * Only user and assistant messages are exported (tool blocks and thinking are
 * stripped with the same sanitizer the public share uses). Markdown is
 * rendered with raw HTML escaped, then the result is re-filtered through an
 * allowlist so the page carries no scripts, handlers or unsafe URL schemes.
 * Images are read only from the conversation's own uploads/artifacts through
 * the contained readers; anything unreadable becomes a text placeholder.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { parseHTML } from 'linkedom';

import { DATA_DIR } from '../../config.js';
import { detectMimetype } from '../../lib/file-content.js';
import { readContainedFile } from '../../lib/read-contained-file.js';
import { effectiveProjectUploadDir } from '../../sandbox/effective-settings.js';
import type { RegisteredGroup } from '../../types.js';
import { readArtifactFile } from './artifacts.js';
import { sanitizePublicAssistantContent } from './public-assistant-content.js';

const MAX_EXPORT_IMAGE_BYTES = 20 * 1024 * 1024;
/** Cap for the whole zip: it is built in memory. */
const MAX_EXPORT_TOTAL_BYTES = 150 * 1024 * 1024;

const LOCAL_IMAGE_URL = /^\/(uploads|artifacts)\/([^/]+)\/([^?#]+)(?:[?#].*)?$/;

/** Local header + central directory + name copies of one stored zip entry. */
const ZIP_ENTRY_OVERHEAD = 512;

const ALLOWED_TAGS = new Set(
  (
    'a blockquote br code del div em h1 h2 h3 h4 h5 h6 hr img li ol p pre ' +
    'span strong sub sup table tbody td tfoot th thead tr ul'
  ).split(' '),
);
const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  code: ['class'],
  ol: ['start'],
  td: ['align'],
  th: ['align'],
};

let sharedStylesheet: Buffer | null = null;
function conversationStylesheet(): Buffer {
  sharedStylesheet ??= readFileSync(
    new URL('./conversation.css', import.meta.url),
  );
  return sharedStylesheet;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function slugify(value: string, maxLength = 60): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '');
}

function isSafeUrl(url: string, extraSchemes: RegExp): boolean {
  const compact = url.replace(/[\u0000- ]/g, '');
  if (!compact) return false;
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i);
  return scheme ? extraSchemes.test(scheme[1]) : true;
}

type LocalImage = {
  kind: 'uploads' | 'artifacts';
  folder: string;
  segments: string[];
};

function parseLocalImageUrl(rawUrl: string): LocalImage | null {
  const match = rawUrl.match(LOCAL_IMAGE_URL);
  if (!match) return null;
  let parts: string[];
  try {
    parts = [match[2], ...match[3].split('/')].map(decodeURIComponent);
  } catch {
    return null;
  }
  const [folder, ...segments] = parts;
  const kind = match[1] as LocalImage['kind'];
  const valid =
    segments.length > 0 &&
    (kind === 'artifacts' || segments.length === 1) &&
    [folder, ...segments].every(
      (s) =>
        s && s !== '.' && s !== '..' && !/[\\/\0]/.test(s) && s.length < 256,
    );
  return valid ? { kind, folder, segments } : null;
}

/** Collects the images of one export and hands out collision-free names. */
class ImageBundle {
  readonly files: Zippable = {};
  private readonly byUrl = new Map<string, string | null>();
  private totalBytes = 0;
  private counter = 0;

  constructor(
    private readonly cidPrefix: string,
    private readonly group: RegisteredGroup,
    /** Bytes the bundled images may occupy in total. */
    private readonly budget: number,
  ) {}

  /** Relative `images/...` path for a local image URL, or null when unavailable. */
  async add(rawUrl: string): Promise<string | null> {
    if (this.byUrl.has(rawUrl)) return this.byUrl.get(rawUrl) ?? null;
    const target = parseLocalImageUrl(rawUrl);
    const data =
      target && target.folder === this.group.folder
        ? await this.read(target).catch(() => null)
        : null;
    let entry: string | null = null;
    // Recognize images by extension or content, never bundle other files.
    const name = target?.segments[target.segments.length - 1] ?? '';
    if (
      data &&
      detectMimetype(name, data).startsWith('image/') &&
      this.totalBytes + data.length + ZIP_ENTRY_OVERHEAD <= this.budget
    ) {
      this.totalBytes += data.length + ZIP_ENTRY_OVERHEAD;
      const filename =
        name
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/^\.+/, '')
          .slice(-80) || 'image';
      entry = `images/${this.cidPrefix}-${++this.counter}-${filename}`;
      this.files[entry] = [new Uint8Array(data), { level: 0 }];
    }
    this.byUrl.set(rawUrl, entry);
    return entry;
  }

  private async read(target: LocalImage): Promise<Buffer | null> {
    if (this.totalBytes >= this.budget) return null;
    if (target.kind === 'artifacts') {
      return readArtifactFile(
        this.group.folder,
        target.segments,
        MAX_EXPORT_IMAGE_BYTES,
      );
    }
    // The upload dir is agent-writable: refuse symlinks, read contained.
    const uploadRoot = effectiveProjectUploadDir(this.group, DATA_DIR);
    const filePath = path.join(uploadRoot, target.segments[0]);
    if ((await fsp.lstat(filePath)).isSymbolicLink()) return null;
    return readContainedFile(uploadRoot, filePath, MAX_EXPORT_IMAGE_BYTES);
  }
}

function missingImageHtml(label: string): string {
  return `<span class="image-missing">${esc(label || 'Image')} (image not available)</span>`;
}

async function imageHtml(
  bundle: ImageBundle,
  src: string,
  alt: string,
  label = alt,
): Promise<string> {
  if (/^https?:\/\//i.test(src)) {
    return `<img src="${esc(src)}" alt="${esc(alt)}">`;
  }
  const bundled = await bundle.add(src);
  return bundled
    ? `<img src="${esc(bundled)}" alt="${esc(alt)}">`
    : missingImageHtml(label);
}

/** Render markdown to HTML that is safe to embed and has local images bundled. */
async function renderMarkdown(
  markdown: string,
  bundle: ImageBundle,
): Promise<string> {
  const rendered = Bun.markdown.html(markdown, {
    tables: true,
    strikethrough: true,
    autolinks: true,
    noHtmlBlocks: true,
    noHtmlSpans: true,
  });
  const { document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  const root = document.getElementById('root')!;
  root.innerHTML = rendered;

  for (const el of [...root.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    const allowed = ALLOWED_ATTRIBUTES[tag] ?? [];
    for (const attr of [...el.attributes]) {
      if (!allowed.includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (!isSafeUrl(href, /^(?:https?|mailto)$/i)) el.removeAttribute('href');
    } else if (tag === 'code' && !/^language-[\w+-]+$/.test(el.className)) {
      el.removeAttribute('class');
    }
  }
  for (const img of [...root.querySelectorAll('img')]) {
    const alt = img.getAttribute('alt') ?? '';
    const src = img.getAttribute('src') ?? '';
    const replacement = await imageHtml(bundle, src, alt);
    // Re-parse the generated fragment so it is inserted as real nodes.
    const holder = document.createElement('span');
    holder.innerHTML = replacement;
    img.replaceWith(...holder.childNodes);
  }
  return root.innerHTML;
}

function formatTimestamp(
  value: unknown,
): { iso: string; label: string } | null {
  const date = new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return { iso, label: `${iso.slice(0, 16).replace('T', ' ')} UTC` };
}

function senderLabel(entry: any): string {
  const name =
    typeof entry.sender_name === 'string' && entry.sender_name.trim()
      ? entry.sender_name.trim()
      : typeof entry.agent_name === 'string'
        ? entry.agent_name.replace(/^ai(?:-main)?:/, '').trim()
        : '';
  return name || (entry.role === 'assistant' ? 'Assistant' : 'User');
}

async function renderAttachments(
  attachments: unknown,
  bundle: ImageBundle,
): Promise<string> {
  if (!Array.isArray(attachments)) return '';
  const parts: string[] = [];
  for (const attachment of attachments) {
    const filename =
      typeof attachment?.filename === 'string' ? attachment.filename : '';
    const caption =
      typeof attachment?.caption === 'string' ? attachment.caption : '';
    if (attachment?.type === 'image' && typeof attachment.url === 'string') {
      const figure = await imageHtml(
        bundle,
        attachment.url,
        caption || filename,
        filename || caption,
      );
      parts.push(
        `<figure>${figure}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`,
      );
    } else if (filename || caption) {
      parts.push(
        `<p class="attachment">Attachment: ${esc(filename || caption)}</p>`,
      );
    }
  }
  return parts.join('\n');
}

export interface ConversationExport {
  /** Download name, `<slug>.zip`. */
  filename: string;
  zip: Uint8Array;
}

/**
 * Build the export zip from transcript entries produced by the chat UI
 * pipeline (`formatPrivateUiTranscriptEntries` + `hydrateTranscriptSenderNames`).
 */
export async function buildConversationExport(input: {
  conversationId: string;
  title?: string | null;
  group: RegisteredGroup;
  entries: unknown[];
  exportedAt?: Date;
  /** Cap for the finished zip; defaults to {@link MAX_EXPORT_TOTAL_BYTES}. */
  maxTotalBytes?: number;
}): Promise<ConversationExport> {
  const cidSlug = slugify(input.conversationId, 120);
  const slug = slugify(input.title ?? '') || `conversation-${cidSlug}`;
  const title = input.title?.trim() || 'Conversation';
  // Board ids start with a shared `conv-<timestamp>` prefix, so the distinguishing
  // part is the tail: that keeps image names unique across exports.
  const cidPrefix = cidSlug.slice(-8).replace(/^-+/, '') || 'conv';
  const maxTotalBytes = input.maxTotalBytes ?? MAX_EXPORT_TOTAL_BYTES;
  const stylesheet = new Uint8Array(conversationStylesheet());

  const render = async (imageBudget: number): Promise<Uint8Array> => {
    const bundle = new ImageBundle(cidPrefix, input.group, imageBudget);

    const messages: string[] = [];
    for (const entry of input.entries as any[]) {
      if (
        !entry ||
        (entry.role !== 'user' && entry.role !== 'assistant') ||
        typeof entry.content !== 'string'
      ) {
        continue;
      }
      const text =
        entry.role === 'assistant'
          ? sanitizePublicAssistantContent(entry.content)
          : entry.content.trim();
      const attachmentsHtml = await renderAttachments(
        entry.attachments,
        bundle,
      );
      if (!text && !attachmentsHtml) continue;
      const body = text ? await renderMarkdown(text, bundle) : '';
      const time = formatTimestamp(entry.created_at);
      messages.push(
        `<article class="message message-${entry.role}">
<header class="message-head"><span class="sender">${esc(senderLabel(entry))}</span>${
          time
            ? ` <time datetime="${esc(time.iso)}">${esc(time.label)}</time>`
            : ''
        }</header>
<div class="message-body">${body}${attachmentsHtml}</div>
</article>`,
      );
    }

    const exportedAt = formatTimestamp(
      (input.exportedAt ?? new Date()).toISOString(),
    )!;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="conversation.css">
</head>
<body>
<main class="conversation">
<header class="conversation-head">
<h1>${esc(title)}</h1>
<p class="meta">Exported <time datetime="${esc(exportedAt.iso)}">${esc(exportedAt.label)}</time></p>
</header>
${messages.length ? messages.join('\n') : '<p class="empty">Empty conversation.</p>'}
</main>
</body>
</html>
`;

    return zipSync({
      [`${slug}.html`]: strToU8(html),
      'conversation.css': stylesheet,
      'images/': new Uint8Array(0),
      ...bundle.files,
    });
  };

  // The images are budgeted first; the page itself is only known afterwards. If
  // the finished zip is over the cap, re-render with the images' budget cut by
  // the excess so the last ones become placeholders. The final attempt bundles
  // no images at all.
  let budget = maxTotalBytes - stylesheet.length;
  let zip = await render(budget);
  for (let attempt = 0; zip.length > maxTotalBytes && budget > 0; attempt++) {
    budget =
      attempt < 2
        ? Math.max(
            0,
            budget - (zip.length - maxTotalBytes) - ZIP_ENTRY_OVERHEAD,
          )
        : 0;
    zip = await render(budget);
  }
  return { filename: `${slug}.zip`, zip };
}
