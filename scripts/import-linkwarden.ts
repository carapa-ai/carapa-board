#!/usr/bin/env bun
/** Standalone, resumable Linkwarden -> CarapaBoard import. See import-linkwarden.md. */
import { CarapaDeviceClient } from '../src/lib/carapa-device-client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

type Collection = {
  id: number;
  name: string;
  parentId?: number | null;
  description?: string | null;
  _count: { links: number };
};
type Link = {
  id: number;
  collectionId: number;
  name: string;
  type: string;
  url?: string | null;
  description?: string;
  textContent?: string;
  readable?: string;
  preview?: string;
  image?: string;
  pdf?: string;
  createdAt?: string;
  updatedAt?: string;
  lastPreserved?: string;
  tags: { name: string }[];
};
type Asset = { name: string; sha256: string };
type Entry = {
  id: number;
  collectionId: number;
  tags: string[];
  documents: Asset[];
  thumbnail?: Asset;
  contentSource: string;
  warnings: string[];
};
type Snapshot = { collections: Collection[]; links: Link[] };
type Plan = {
  version: 1;
  source: string;
  prefix: string;
  collections: Collection[];
  entries: Entry[];
};
type Journal = {
  board: string;
  planHash: string;
  collections: Record<string, string>;
  files: Record<string, string>;
};
type KB = { id: string; name: string; description: string | null };
type KBFile = { name: string; tags: string[]; thumbnail?: { name: string } };

const { values } = parseArgs({
  options: {
    'source-url': { type: 'string', default: 'http://localhost:4658' },
    'source-token-file': { type: 'string', default: '~/.secrets/lw-api' },
    'board-url': { type: 'string' },
    'device-file': { type: 'string' },
    'state-dir': { type: 'string' },
    prefix: { type: 'string', default: 'Linkwarden / ' },
    prepare: { type: 'boolean' },
    apply: { type: 'boolean' },
    verify: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const expand = (p: string) =>
  path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
const hash = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const available = (s?: string) => !!s && s !== 'unavailable';
const readJSON = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, 'utf8'));
function saveJSON(file: string, value: unknown) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(`${file}.tmp`, file);
}
function origin(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new Error('Use an origin URL without credentials, path or query');
  if (
    u.protocol !== 'https:' &&
    !(
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    )
  )
    throw new Error('HTTP is allowed only for loopback URLs');
  return u.origin;
}
async function request(base: string, route: string, init: RequestInit = {}) {
  const response = await fetch(base + route, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  // Do not print response bodies: authentication responses can contain secrets.
  if (!response.ok)
    throw new Error(
      `${init.method || 'GET'} ${route.split('?')[0]}: HTTP ${response.status}`,
    );
  return response;
}
function collectionName(
  c: Collection,
  all: Collection[],
  prefix: string,
  seen = new Set<number>(),
): string {
  if (seen.has(c.id)) throw new Error('Collection parent cycle');
  seen.add(c.id);
  const parent = all.find((x) => x.id === c.parentId);
  return parent
    ? `${collectionName(parent, all, prefix, seen)} / ${c.name}`
    : `${prefix}${c.name}`;
}
function tags(link: Link) {
  const seen = new Set<string>();
  return link.tags
    .map((t) => t.name.trim())
    .filter((t) => {
      if (!t || seen.has(t.toLowerCase())) return false;
      seen.add(t.toLowerCase());
      return true;
    });
}
function imageExtension(data: Buffer): string {
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return '.jpg';
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return '.png';
  if (
    data.subarray(0, 4).toString() === 'RIFF' &&
    data.subarray(8, 12).toString() === 'WEBP'
  )
    return '.webp';
  if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) return '.gif';
  throw new Error('Archive is not a supported raster image');
}
function markdown(html: string, sourceUrl?: string | null) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  document
    .querySelectorAll('script,style,iframe,form,button,input')
    .forEach((el) => el.remove());
  for (const el of document.querySelectorAll('[href],[src]')) {
    for (const attr of ['href', 'src']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      try {
        const url = new URL(value, sourceUrl || undefined);
        if (['https:', 'http:', 'mailto:'].includes(url.protocol))
          el.setAttribute(attr, url.href);
        else el.removeAttribute(attr);
      } catch {
        el.removeAttribute(attr);
      }
    }
  }
  const converter = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  converter.addRule('table', {
    filter: 'table',
    replacement(_content, node) {
      const rows = Array.from(
        (node as unknown as Element).querySelectorAll('tr'),
      )
        .map((row) =>
          Array.from(row.children)
            .filter((cell) => ['TH', 'TD'].includes(cell.tagName))
            .map((cell) =>
              converter
                .turndown(cell.innerHTML)
                .trim()
                .replace(/\|/g, '\\|')
                .replace(/\s*\n\s*/g, ' '),
            ),
        )
        .filter((row) => row.length);
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
      return `\n\n${line(rows[0])}\n${line(Array(width).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
    },
  });
  return converter.turndown(document.body.innerHTML);
}

async function prepare(stateDir: string, source: string): Promise<Plan> {
  const token = fs
    .readFileSync(expand(values['source-token-file']!), 'utf8')
    .trim();
  const get = (route: string) =>
    request(source, route, { headers: { Authorization: `Bearer ${token}` } });
  const snapshotFile = path.join(stateDir, 'snapshot.json');
  let snapshot: Snapshot;
  if (fs.existsSync(snapshotFile)) {
    const saved = readJSON<Snapshot & { source: string }>(snapshotFile);
    if (saved.source !== source)
      throw new Error('Snapshot belongs to a different Linkwarden origin');
    snapshot = saved;
  } else {
    const collections = (await (await get('/api/v1/collections')).json())
      .response as Collection[];
    const links: Link[] = [];
    const seen = new Set<number>();
    let cursor: number | undefined;
    for (;;) {
      const page = (
        await (
          await get(`/api/v1/links?sort=0${cursor ? `&cursor=${cursor}` : ''}`)
        ).json()
      ).response as Link[];
      if (!Array.isArray(page)) throw new Error('Unexpected Linkwarden page');
      if (!page.length) break;
      for (const link of page) {
        if (!Number.isInteger(link.id) || seen.has(link.id))
          throw new Error(
            'Pagination repeated a link; refusing a partial import',
          );
        seen.add(link.id);
        links.push(link);
      }
      cursor = page.at(-1)!.id;
    }
    for (const c of collections) {
      if (
        links.filter((l) => l.collectionId === c.id).length !== c._count.links
      )
        throw new Error(
          `Collection ${c.id} count changed; retry with a new state directory`,
        );
    }
    if (links.some((l) => !collections.some((c) => c.id === l.collectionId)))
      throw new Error('A link refers to an inaccessible collection');
    snapshot = { collections, links };
    saveJSON(snapshotFile, { source, ...snapshot });
  }
  const assetDir = path.join(stateDir, 'assets');
  const archiveDir = path.join(stateDir, 'archives');
  fs.mkdirSync(assetDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  async function archive(link: Link, format: number, preview = false) {
    const file = path.join(
      archiveDir,
      `${link.id}-${format}${preview ? '-preview' : ''}`,
    );
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const response = await get(
      `/api/v1/archives/${link.id}?format=${format}${preview ? '&preview=true' : ''}`,
    );
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 40 * 1024 * 1024)
      throw new Error(`Archive ${link.id} is empty or exceeds 40 MiB`);
    fs.writeFileSync(file, data, { mode: 0o600 });
    return data;
  }
  function asset(name: string, data: string | Buffer): Asset {
    fs.writeFileSync(path.join(assetDir, name), data, { mode: 0o600 });
    return { name, sha256: hash(data) };
  }
  const entries: Entry[] = [];
  for (const link of snapshot.links) {
    const title = link.name.trim() || link.url || `Linkwarden ${link.id}`;
    const slug =
      title
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90) || 'document';
    const stem = `lw-${link.id}-${slug}`;
    const entry: Entry = {
      id: link.id,
      collectionId: link.collectionId,
      tags: tags(link),
      documents: [],
      contentSource: 'url-only',
      warnings: [],
    };
    let body = '';
    if (link.type === 'pdf') {
      const pdf = await archive(link, 2);
      if (pdf.subarray(0, 5).toString() !== '%PDF-')
        throw new Error(`Link ${link.id}: invalid PDF`);
      entry.documents.push(asset(`${stem}.pdf`, pdf));
      entry.contentSource = 'pdf';
      body =
        'The original uploaded PDF is preserved alongside this source record.';
    } else if (link.type === 'image') {
      const image = await archive(link, link.image?.endsWith('.png') ? 0 : 1);
      entry.documents.push(asset(`${stem}${imageExtension(image)}`, image));
      entry.contentSource = 'image';
      body =
        'The original saved image is preserved alongside this source record.';
    } else if (available(link.readable)) {
      const readable = JSON.parse((await archive(link, 3)).toString());
      body = readable.content
        ? markdown(readable.content, link.url)
        : readable.textContent || '';
      entry.contentSource = body.trim() ? 'readable' : 'url-only';
    }
    if (!body.trim() && link.textContent?.trim()) {
      body = link.textContent;
      entry.contentSource = 'textContent';
    }
    if (!body.trim()) {
      body = 'No readable content was available in Linkwarden at import time.';
      entry.warnings.push('No readable archive');
    }
    if (
      /just a moment|security checkpoint|access denied|attention required/i.test(
        link.name,
      )
    )
      entry.warnings.push('Saved title suggests a blocked or challenge page');
    const meta = {
      title,
      source: 'Linkwarden',
      source_url: link.url || null,
      linkwarden_url: `${source}/links/${link.id}`,
      linkwarden_id: link.id,
      collection: collectionName(
        snapshot.collections.find((c) => c.id === link.collectionId)!,
        snapshot.collections,
        '',
      ),
      collection_id: link.collectionId,
      created_at: link.createdAt,
      updated_at: link.updatedAt,
      preserved_at: link.lastPreserved,
      content_source: entry.contentSource,
      tags: entry.tags,
    };
    const frontmatter = Object.entries(meta)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    const text = `---\n${frontmatter}\n---\n\n# ${title.replace(/[\r\n]+/g, ' ')}\n\n${link.url ? `Source: <${link.url.replace(/[<>\r\n]/g, '')}>\n\n` : ''}${link.description ? `${link.description}\n\n---\n\n` : ''}${body.trim()}\n`;
    // Binary documents get a separate source record, so the saved image stays visible as a document.
    entry.documents.push(
      asset(
        `${stem}${['pdf', 'image'].includes(link.type) ? '-source' : ''}.md`,
        text,
      ),
    );
    if (available(link.preview) && link.type !== 'image') {
      const image = await archive(link, 1, true);
      entry.thumbnail = asset(`${stem}${imageExtension(image)}`, image);
    }
    entries.push(entry);
    if (entries.length % 20 === 0)
      console.log(`Prepared ${entries.length}/${snapshot.links.length} links`);
  }
  const plan: Plan = {
    version: 1,
    source,
    prefix: values.prefix!,
    collections: snapshot.collections,
    entries,
  };
  saveJSON(path.join(stateDir, 'plan.json'), plan);
  console.log(
    JSON.stringify(
      {
        links: entries.length,
        collections: plan.collections.map((c) => ({
          name: collectionName(c, plan.collections, plan.prefix),
          links: c._count.links,
        })),
        documents: entries.reduce((n, e) => n + e.documents.length, 0),
        thumbnails: entries.filter((e) => e.thumbnail).length,
        warnings: entries
          .filter((e) => e.warnings.length)
          .map((e) => ({ id: e.id, warnings: e.warnings })),
      },
      null,
      2,
    ),
  );
  return plan;
}

async function deviceAuth(board: string) {
  if (!values['device-file'])
    throw new Error(
      '--device-file is required; pair using scripts/carapa-device.ts first',
    );
  const client = CarapaDeviceClient.load(board, values['device-file']);
  return client.request.bind(client);
}

async function apply(stateDir: string, board: string, verifyOnly: boolean) {
  const planFile = path.join(stateDir, 'plan.json');
  const plan = readJSON<Plan>(planFile);
  if (plan.version !== 1) throw new Error('Unsupported plan version');
  const journalFile = path.join(stateDir, 'journal.json');
  const planHash = hash(fs.readFileSync(planFile));
  const journal: Journal = fs.existsSync(journalFile)
    ? readJSON<Journal>(journalFile)
    : { board, planHash, collections: {}, files: {} };
  if (journal.board !== board || journal.planHash !== planHash)
    throw new Error('Journal belongs to a different destination or plan');
  const api = (await deviceAuth(board))!;
  const kbs = (await (await api('/api/knowledge')).json()) as KB[];
  const persist = () => saveJSON(journalFile, journal);
  for (const c of plan.collections) {
    const marker = `Linkwarden source: ${plan.source}; collection ID: ${c.id}.`;
    const matches = kbs.filter((kb) => kb.description?.startsWith(marker));
    if (matches.length > 1)
      throw new Error(`Multiple destination KBs match collection ${c.id}`);
    let kb = journal.collections[c.id]
      ? kbs.find((k) => k.id === journal.collections[c.id])
      : matches[0];
    if (journal.collections[c.id] && !kb)
      throw new Error(
        `Previously imported KB for collection ${c.id} was removed or is inaccessible`,
      );
    if (!kb) {
      if (verifyOnly) throw new Error(`Missing KB for collection ${c.id}`);
      kb = (await (
        await api('/api/knowledge', 'POST', {
          name: collectionName(c, plan.collections, plan.prefix),
          description: `${marker}\n${c.description || ''}`.trim(),
        })
      ).json()) as KB;
    }
    journal.collections[c.id] = kb.id;
    persist();
    const base = `/api/knowledge/${encodeURIComponent(kb.id)}/files`;
    const list = (await (await api(base)).json()) as KBFile[];
    const byName = new Map(list.map((f) => [f.name, f]));
    async function upload(
      asset: Asset,
      entry: Entry,
      isThumbnail = false,
      requestedName = asset.name,
    ) {
      const bytes = fs.readFileSync(path.join(stateDir, 'assets', asset.name));
      if (hash(bytes) !== asset.sha256)
        throw new Error(`Prepared asset was modified: ${asset.name}`);
      const journalKey = `${c.id}/${asset.name}`;
      const savedName = journal.files[journalKey] || requestedName;
      // Reads use the canonical query endpoint and therefore support proxy-safe signatures.
      let existing: Response | undefined;
      try {
        existing = await api(
          `${base}/content?${new URLSearchParams({ filename: savedName })}`,
        );
      } catch (error) {
        if (!(error instanceof Error && error.message.endsWith('HTTP 404')))
          throw error;
      }
      if (existing) {
        if (hash(new Uint8Array(await existing.arrayBuffer())) !== asset.sha256)
          throw new Error(
            `Destination content differs: ${savedName}; refusing to overwrite`,
          );
        if (!isThumbnail) {
          const current = byName.get(savedName)?.tags;
          if (
            !current ||
            JSON.stringify([...current].sort()) !==
              JSON.stringify([...entry.tags].sort())
          )
            throw new Error(
              `Destination tags differ: ${savedName}; refusing to replace user edits`,
            );
        }
        journal.files[journalKey] = savedName;
        persist();
        return savedName;
      }
      if (verifyOnly || journal.files[journalKey])
        throw new Error(`Previously imported file is missing: ${savedName}`);
      const result = await (
        await api(base, 'POST', {
          name: requestedName,
          content: bytes.toString('base64'),
          tags: isThumbnail ? [] : entry.tags,
        })
      ).json();
      if (!result.success || typeof result.path !== 'string')
        throw new Error('Unexpected upload response; rerun to reconcile');
      journal.files[journalKey] = result.path;
      persist();
      return result.path as string;
    }
    let count = 0;
    for (const entry of plan.entries.filter((e) => e.collectionId === c.id)) {
      const primaryPath = await upload(entry.documents[0], entry);
      for (const doc of entry.documents.slice(1)) await upload(doc, entry);
      if (entry.thumbnail) {
        const assignedStem = primaryPath.slice(
          0,
          -path.extname(primaryPath).length,
        );
        await upload(
          entry.thumbnail,
          entry,
          true,
          assignedStem + path.extname(entry.thumbnail.name),
        );
      }
      count++;
      if (count % 20 === 0)
        console.log(
          `${kb.name}: ${count}/${c._count.links} ${verifyOnly ? 'verified' : 'imported'}`,
        );
    }
    const after = (await (await api(base)).json()) as KBFile[];
    for (const entry of plan.entries.filter((e) => e.collectionId === c.id)) {
      for (const doc of entry.documents) {
        const f = after.find(
          (x) => x.name === journal.files[`${c.id}/${doc.name}`],
        );
        if (
          !f ||
          JSON.stringify([...f.tags].sort()) !==
            JSON.stringify([...entry.tags].sort())
        )
          throw new Error(`File/tag verification failed for ${doc.name}`);
        if (
          doc === entry.documents[0] &&
          entry.thumbnail &&
          f.thumbnail?.name !== journal.files[`${c.id}/${entry.thumbnail.name}`]
        )
          throw new Error(`Thumbnail association failed for ${doc.name}`);
      }
    }
    console.log(`${kb.name}: ${count} links, files/tags/thumbnails verified`);
  }
  console.log(
    `${verifyOnly ? 'Verification' : 'Import'} complete: ${plan.entries.length} links in ${plan.collections.length} KBs. Indexing runs in the background.`,
  );
}

async function main() {
  if (
    values.help ||
    !['prepare', 'apply', 'verify'].some(
      (key) => values[key as keyof typeof values],
    )
  ) {
    console.log(
      'Usage: bun scripts/import-linkwarden.ts --state-dir DIR --prepare\n       bun scripts/import-linkwarden.ts --state-dir DIR --board-url URL --device-file FILE --apply|--verify\nSee scripts/import-linkwarden.md for credentials, resume behavior and format details.',
    );
    return;
  }
  if (
    ['prepare', 'apply', 'verify'].filter(
      (key) => values[key as keyof typeof values],
    ).length !== 1
  )
    throw new Error('Choose exactly one mode');
  if (!values['state-dir']) throw new Error('--state-dir is required');
  const stateDir = expand(values['state-dir']);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, '.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    if (values.prepare) {
      if (fs.existsSync(path.join(stateDir, 'journal.json')))
        throw new Error(
          'Do not re-prepare an applied plan; use a new state directory',
        );
      await prepare(stateDir, origin(values['source-url']!));
    } else {
      if (!values['board-url']) throw new Error('--board-url is required');
      await apply(stateDir, origin(values['board-url']), !!values.verify);
    }
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Import failed');
  process.exitCode = 1;
});
