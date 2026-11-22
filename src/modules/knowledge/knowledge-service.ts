import fs from 'fs';
import path from 'path';
import { sha256Hex } from '../../lib/hash.js';
import { spawn } from 'child_process';
import { PDFParse } from 'pdf-parse';
import { trackBackgroundWork } from '../../lib/background-work-gate.js';
import { logger } from '../../logger.js';
import { KNOWLEDGE_DIR, KNOWLEDGE_VERIFY_ENGINE } from '../../config.js';
import { isProbability, jevSystemOne } from '../../lib/jev-client.js';
import * as db from '../../db.js';
import {
  embedText,
  upsertKnowledgeChunkVector,
  searchKnowledgeSimilar,
  deleteKnowledgeBaseVectors,
  deleteKnowledgeFileVectors,
} from '../vector-store/store.js';
import { directLlmFallbackOption, runDirectLlm } from '../chat/direct-llm.js';
import { getCachedWebView } from '../web/proxy.js';
import { getGroupByFolder } from '../../state-manager.js';
import { chunkMarkdown } from './chunk-markdown.js';
import {
  getDefaultRuntimeSelection,
  isDirectRuntime,
  resolveRuntimeSelection,
} from '../../lib/chat-agents.js';
import {
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeFile,
  KnowledgeTag,
  KnowledgeDocumentUpdate,
  KnowledgeDocumentMetadata,
  KnowledgeDocumentSummary,
} from './types.js';
import { parseKnowledgeDate } from './dates.js';
import type { KnowledgeDocumentRowUpdate } from './db-kb.js';
import {
  normalizeKnowledgeTags,
  matchesKnowledgeTags,
  tagKey,
} from './tags.js';

/** Minimum Jev match probability for a chunk to pass the jev verifier. */
const KNOWLEDGE_VERIFY_JEV_THRESHOLD = 0.5;

/** Counts-only fields of the `knowledge_search` log line (never query text or names). */
interface KnowledgeSearchTelemetry {
  project: string | null;
  kbCount: number;
  tagFiltered: boolean;
  embedded: boolean;
  vectorHits: number | null;
  afterMetadataFilter: number;
  path: 'vector' | 'keyword' | 'none';
  keywordHits: number | null;
  returned: number;
  topScore: number | null;
  minReturnedScore: number | null;
  verify: boolean;
  verifiedCount: number | null;
  /** Set only when the search rejected. */
  failed?: true;
  reason?: 'no_kbs' | 'kb_filter_empty' | 'tag_filter_empty' | 'no_candidates';
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

const THUMBNAIL_EXTENSIONS = [
  '.webp',
  '.png',
  '.jpg',
  '.jpeg',
  '.avif',
  '.gif',
];

function isThumbnailImage(name: string): boolean {
  return THUMBNAIL_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

function documentBasename(name: string): string {
  return name.slice(0, name.length - path.extname(name).length);
}

function siblingThumbnails(filePath: string): string[] {
  if (isThumbnailImage(filePath) || !fs.existsSync(path.dirname(filePath)))
    return [];
  const stem = documentBasename(path.basename(filePath));
  return fs
    .readdirSync(path.dirname(filePath))
    .filter((name) => isThumbnailImage(name) && documentBasename(name) === stem)
    .map((name) => path.join(path.dirname(filePath), name))
    .filter((name) => fs.lstatSync(name).isFile())
    .sort(
      (a, b) =>
        THUMBNAIL_EXTENSIONS.indexOf(path.extname(a).toLowerCase()) -
          THUMBNAIL_EXTENSIONS.indexOf(path.extname(b).toLowerCase()) ||
        a.localeCompare(b),
    );
}

function hasSiblingDocument(filePath: string): boolean {
  const stem = documentBasename(path.basename(filePath));
  return fs
    .readdirSync(path.dirname(filePath))
    .some(
      (name) =>
        !name.startsWith('.') &&
        !isThumbnailImage(name) &&
        documentBasename(name) === stem &&
        fs.lstatSync(path.join(path.dirname(filePath), name)).isFile(),
    );
}

// Share concurrent walks, but discard the snapshot as soon as it completes so
// externally added or removed files remain visible on the next request.
const knowledgeWalks = new Map<
  string,
  Promise<Array<{ name: string; stat: fs.Stats }>>
>();

function walkKnowledgeFiles(
  root: string,
): Promise<Array<{ name: string; stat: fs.Stats }>> {
  const existing = knowledgeWalks.get(root);
  if (existing) return existing;
  const walk = async (
    dir: string,
  ): Promise<Array<{ name: string; stat: fs.Stats }>> => {
    const files: Array<{ name: string; stat: fs.Stats }> = [];
    for (const item of await fs.promises.readdir(dir)) {
      if (item.startsWith('.')) continue;
      const fullPath = path.join(dir, item);
      try {
        const stat = await fs.promises.lstat(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) files.push(...(await walk(fullPath)));
        else files.push({ name: path.relative(root, fullPath), stat });
      } catch (err) {
        logger.warn({ err, fullPath }, 'Knowledge: skipping unreadable entry');
      }
    }
    return files;
  };
  const pending = walk(root).finally(() => knowledgeWalks.delete(root));
  knowledgeWalks.set(root, pending);
  return pending;
}

export class KnowledgeFileError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

function knowledgeFilePath(kb: KnowledgeBase, name: string): string {
  if (
    !name ||
    path.isAbsolute(name) ||
    path.win32.isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part.startsWith('.'))
  ) {
    throw new KnowledgeFileError(
      'Expected a relative document path without hidden or parent directories',
    );
  }
  const root = path.resolve(kb.folder_path);
  const filePath = path.resolve(root, name);
  // Do not allow a symlink in an existing parent to redirect a metadata/write request.
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new KnowledgeFileError(
        'Symbolic links are not supported for knowledge documents',
      );
    }
  }
  return filePath;
}

function knowledgeChunkId(kbId: string, source: string, index: number): string {
  return `${kbId}-${sha256Hex(source)}-${index}`;
}

function directLlmEndpoint(agentConfig: any): string | undefined {
  if (!isDirectRuntime(agentConfig || {})) return undefined;
  return (
    agentConfig?.baseUrl ||
    agentConfig?.env?.OPENAI_BASE_URL ||
    agentConfig?.env?.ANTHROPIC_BASE_URL
  );
}

/** Fallback "added" time for files without a stored value: birthtime when the filesystem has one, else mtime. */
function fileAddedAt(stat: fs.Stats): Date {
  return new Date(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
}

/** Convert API metadata (ISO strings) to its persisted shape; rejects invalid dates. */
function toRowMetadata(
  metadata: Partial<KnowledgeDocumentMetadata>,
): KnowledgeDocumentRowUpdate {
  const { publishedAt, ...rest } = metadata;
  if (publishedAt === undefined) return rest;
  if (publishedAt === null) return { ...rest, publishedAt: null };
  const parsed = parseKnowledgeDate(publishedAt);
  if (!parsed)
    throw new KnowledgeFileError(
      'publishedAt must be an ISO date (YYYY-MM-DD) or datetime',
    );
  return { ...rest, publishedAt: parsed };
}

/** Persist a file-derived added_at for a row written without one (metadata on a dropped-in file) so it stays stable if the file is later touched. */
async function backfillAddedAt(
  kbId: string,
  relativePath: string,
  addedAt: Date,
): Promise<void> {
  await db
    .backfillKnowledgeDocumentAddedAt(kbId, relativePath, addedAt)
    .catch((err) =>
      logger.warn(
        { err, kbId, path: relativePath },
        'Knowledge: failed to backfill added_at',
      ),
    );
}

export class KnowledgeService {
  /** Create a new knowledge base */
  static async createKB(
    name: string,
    description: string | null,
  ): Promise<KnowledgeBase> {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'kb';
    const id = `${slug}-${Math.random().toString(36).substring(2, 7)}`;
    const folder_path = path.join(KNOWLEDGE_DIR, id);
    fs.mkdirSync(folder_path, { recursive: true });

    const kb: KnowledgeBase = {
      id,
      name,
      description,
      folder_path,
      last_indexed_at: null,
      created_at: Date.now(),
    };

    await db.createKnowledgeBase(kb);
    return kb;
  }

  /** Get all knowledge bases */
  static async getAllKBs(): Promise<KnowledgeBase[]> {
    return await db.getAllKnowledgeBases();
  }

  /** Get knowledge bases shared with a project */
  static async getSharedKBs(group_folder: string): Promise<KnowledgeBase[]> {
    return await db.getSharedKnowledgeBases(group_folder);
  }

  /** Share a KB with a project */
  static async shareKB(kb_id: string, group_folder: string): Promise<void> {
    await db.shareKnowledgeBase(kb_id, group_folder);
  }

  /** Unshare a KB from a project */
  static async unshareKB(kb_id: string, group_folder: string): Promise<void> {
    await db.unshareKnowledgeBase(kb_id, group_folder);
  }

  /** Update KB metadata */
  static async updateKB(
    id: string,
    updates: { name?: string; description?: string | null },
  ): Promise<KnowledgeBase> {
    const kb = await db.getKnowledgeBase(id);
    if (!kb) throw new Error('Knowledge Base not found');

    await db.updateKnowledgeBase(id, updates);
    return { ...kb, ...updates };
  }

  /** Delete a knowledge base completely */
  static async deleteKB(id: string): Promise<void> {
    const kb = await db.getKnowledgeBase(id);
    if (!kb) return;

    // 1. Delete vectors from Neo4j
    try {
      await deleteKnowledgeBaseVectors(id);
    } catch (err) {
      logger.error(
        { err, kb_id: id },
        'Failed to delete knowledge base vectors',
      );
    }

    // 2. Delete folder from disk
    try {
      if (fs.existsSync(kb.folder_path)) {
        fs.rmSync(kb.folder_path, { recursive: true, force: true });
      }
    } catch (err) {
      logger.error(
        { err, kb_id: id, path: kb.folder_path },
        'Failed to delete knowledge base folder',
      );
    }

    // 3. Delete metadata from db
    await db.deleteKnowledgeBase(id);
  }

  /** List files in a KB */
  static async listFiles(kb_id: string): Promise<KnowledgeFile[]> {
    const kb = await db.getKnowledgeBase(kb_id);
    if (!kb) throw new Error(`Knowledge Base ${kb_id} not found`);

    if (!fs.existsSync(kb.folder_path)) return [];

    const metadata = new Map(
      (await db.getKnowledgeDocuments(kb_id)).map((doc) => [doc.path, doc]),
    );
    const allFiles: KnowledgeFile[] = [];
    const undatedRows: Array<[string, Date]> = [];

    for (const { name, stat } of await walkKnowledgeFiles(kb.folder_path)) {
      const row = metadata.get(name);
      allFiles.push({
        name,
        size: stat.size,
        mtime: stat.mtimeMs,
        addedAt: (row?.addedAt ?? fileAddedAt(stat)).toISOString(),
        publishedAt: row?.publishedAt?.toISOString() ?? null,
        title: row?.title ?? null,
        description: row?.description ?? null,
        sourceUrl: row?.sourceUrl ?? null,
        tags: row?.tags ?? [],
      });
      if (row && !row.addedAt) undatedRows.push([name, fileAddedAt(stat)]);
    }
    for (const [name, addedAt] of undatedRows)
      await backfillAddedAt(kb_id, name, addedAt);
    const documentStems = new Set(
      allFiles
        .filter((file) => !isThumbnailImage(file.name))
        .map((file) => documentBasename(file.name)),
    );
    const thumbnails = new Map<string, KnowledgeFile[]>();
    for (const file of allFiles) {
      if (!isThumbnailImage(file.name)) continue;
      const stem = documentBasename(file.name);
      const siblings = thumbnails.get(stem) || [];
      siblings.push(file);
      thumbnails.set(stem, siblings);
    }
    return allFiles
      .filter(
        (file) =>
          !isThumbnailImage(file.name) ||
          !documentStems.has(documentBasename(file.name)),
      )
      .map((file) => {
        if (isThumbnailImage(file.name)) return file;
        const thumbnail = thumbnails
          .get(documentBasename(file.name))
          ?.sort(
            (a, b) =>
              THUMBNAIL_EXTENSIONS.indexOf(path.extname(a.name).toLowerCase()) -
                THUMBNAIL_EXTENSIONS.indexOf(
                  path.extname(b.name).toLowerCase(),
                ) || a.name.localeCompare(b.name),
          )[0];
        return thumbnail
          ? {
              ...file,
              thumbnail: { name: thumbnail.name, mtime: thumbnail.mtime },
            }
          : file;
      });
  }

  static async listDocuments(
    kbId: string,
    offset: number,
    limit: number,
    addedAfter?: Date,
  ) {
    const files = (await this.listFiles(kbId))
      .filter(
        (file) =>
          !addedAfter || Date.parse(file.addedAt) > addedAfter.getTime(),
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const metadata = new Map(
      (await db.getKnowledgeDocuments(kbId)).map((doc) => [doc.path, doc]),
    );
    const documents: KnowledgeDocumentSummary[] = files
      .slice(offset, offset + limit)
      .map((file) => {
        const document = metadata.get(file.name);
        return {
          filename: file.name,
          tags: document?.tags ?? [],
          title: document?.title ?? null,
          description: document?.description ?? null,
          sourceUrl: document?.sourceUrl ?? null,
          addedAt: file.addedAt,
          modifiedAt: new Date(file.mtime).toISOString(),
          publishedAt: file.publishedAt,
        };
      });
    const end = offset + documents.length;
    return {
      documents,
      total: files.length,
      nextOffset: end < files.length ? end : null,
    };
  }

  static async getDocumentPath(kbId: string, name: string): Promise<string> {
    const kb = await db.getKnowledgeBase(kbId);
    if (!kb) throw new KnowledgeFileError('Knowledge Base not found', 404);
    const documentPath = knowledgeFilePath(kb, name);
    if (!fs.existsSync(documentPath) || !fs.statSync(documentPath).isFile())
      throw new KnowledgeFileError('Document not found', 404);
    return documentPath;
  }

  static async readDocument(kbId: string, filename: string): Promise<string> {
    const filePath = await this.getDocumentPath(kbId, filename);
    return this.convertToMarkdown(filePath);
  }

  static async readDocumentDetails(kbId: string, filename: string) {
    const filePath = await this.getDocumentPath(kbId, filename);
    const document = await db.getKnowledgeDocument(kbId, filename);
    const stat = fs.statSync(filePath);
    const thumbnailPath = siblingThumbnails(filePath)[0];
    const publishedAt = document?.publishedAt?.toISOString() ?? null;
    let addedAt = document?.addedAt;
    if (!addedAt) {
      addedAt = fileAddedAt(stat);
      if (document) await backfillAddedAt(kbId, filename, addedAt);
    }
    return {
      size: stat.size,
      mtime: stat.mtimeMs,
      addedAt: addedAt.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      publishedAt,
      metadata: {
        tags: document?.tags ?? [],
        title: document?.title ?? null,
        description: document?.description ?? null,
        sourceUrl: document?.sourceUrl ?? null,
        publishedAt,
      },
      thumbnail: thumbnailPath
        ? {
            name: path.basename(thumbnailPath),
            mtime: fs.statSync(thumbnailPath).mtimeMs,
            url: `/api/knowledge/${encodeURIComponent(kbId)}/files/thumbnail?${new URLSearchParams({ filename })}`,
          }
        : null,
    };
  }

  /** Update an existing file; absent fields are preserved. */
  static async updateDocument(
    kbId: string,
    filename: string,
    updates: KnowledgeDocumentUpdate,
  ) {
    const filePath = await this.getDocumentPath(kbId, filename);
    if (
      updates.content !== undefined &&
      !['.md', '.txt'].includes(path.extname(filename).toLowerCase())
    )
      throw new KnowledgeFileError(
        'Content updates are only supported for non-binary .md and .txt documents',
      );
    if (updates.content !== undefined) {
      const original = fs.readFileSync(filePath);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(original);
        if (original.includes(0) || updates.content.includes('\0'))
          throw new Error('Binary content');
      } catch {
        throw new KnowledgeFileError(
          'Content updates require non-binary UTF-8 text',
        );
      }
    }
    const content =
      updates.content !== undefined ? Buffer.from(updates.content) : undefined;
    const metadata = toRowMetadata(updates.metadata ?? {});
    if (metadata.tags !== undefined)
      metadata.tags = normalizeKnowledgeTags(metadata.tags);

    let thumbnail: { path: string; data: Buffer } | undefined;
    if (updates.thumbnail !== undefined && isThumbnailImage(filePath))
      throw new KnowledgeFileError(
        'Image documents cannot have sibling thumbnails',
      );
    if (updates.thumbnail) {
      const data = updates.thumbnail;
      if (data.length > 10 * 1024 * 1024)
        throw new KnowledgeFileError('Thumbnail exceeds 10 MB');
      const extension = data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? '.png'
        : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          ? '.jpg'
          : data.toString('ascii', 0, 4) === 'RIFF' &&
              data.toString('ascii', 8, 12) === 'WEBP'
            ? '.webp'
            : ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))
              ? '.gif'
              : null;
      if (!extension)
        throw new KnowledgeFileError(
          'Thumbnail source must be PNG, JPEG, WebP, or GIF',
        );
      const kb = (await db.getKnowledgeBase(kbId))!;
      thumbnail = {
        path: knowledgeFilePath(kb, documentBasename(filename) + extension),
        data,
      };
    }
    // Validate everything before changing disk; restore files if metadata persistence fails.
    const originals = new Map<string, Buffer | null>();
    const remember = (name: string) => {
      if (!originals.has(name))
        originals.set(name, fs.existsSync(name) ? fs.readFileSync(name) : null);
    };
    if (content !== undefined) remember(filePath);
    const oldThumbnails =
      updates.thumbnail !== undefined ? siblingThumbnails(filePath) : [];
    for (const name of oldThumbnails) remember(name);
    if (thumbnail) remember(thumbnail.path);
    try {
      if (content !== undefined) fs.writeFileSync(filePath, content);
      for (const name of oldThumbnails) fs.unlinkSync(name);
      if (thumbnail) fs.writeFileSync(thumbnail.path, thumbnail.data);
      await db.updateKnowledgeDocumentMetadata(kbId, filename, metadata);
    } catch (err) {
      for (const [name, data] of originals) {
        if (data === null) fs.rmSync(name, { force: true });
        else fs.writeFileSync(name, data);
      }
      throw err;
    }
    if (content !== undefined) {
      trackBackgroundWork('indexing job', () =>
        this.indexFile(kbId, filePath),
      ).catch((err) => {
        logger.error(
          { err, kb_id: kbId, filePath },
          'Background indexing failed',
        );
      });
    }
    return this.readDocumentDetails(kbId, filename);
  }

  static async getThumbnailPath(kbId: string, name: string): Promise<string> {
    const documentPath = await this.getDocumentPath(kbId, name);
    const thumbnail = siblingThumbnails(documentPath)[0];
    if (!thumbnail) throw new KnowledgeFileError('Thumbnail not found', 404);
    return thumbnail;
  }

  static async listTags(kbId: string): Promise<KnowledgeTag[]> {
    const tags = new Map<string, KnowledgeTag>();
    for (const file of await this.listFiles(kbId)) {
      for (const name of file.tags) {
        const key = tagKey(name);
        const tag = tags.get(key);
        if (tag) tag.count++;
        else tags.set(key, { name, count: 1 });
      }
    }
    return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  static async updateFileTags(
    kbId: string,
    name: string,
    tags: string[],
  ): Promise<string[]> {
    const normalized = normalizeKnowledgeTags(tags);
    const kb = await db.getKnowledgeBase(kbId);
    if (!kb) throw new KnowledgeFileError('Knowledge Base not found', 404);
    const filePath = knowledgeFilePath(kb, name);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new KnowledgeFileError('Document not found', 404);
    }
    await db.setKnowledgeDocumentTags(
      kbId,
      path.relative(kb.folder_path, filePath),
      normalized,
    );
    return normalized;
  }

  /** Add a file to a KB */
  static async addFile(
    kb_id: string,
    name: string,
    content: Buffer,
    tags: string[] = [],
    metadata: Partial<Omit<KnowledgeDocumentMetadata, 'tags'>> = {},
  ): Promise<string> {
    const normalizedTags = normalizeKnowledgeTags(tags);
    const rowMetadata = toRowMetadata(metadata);
    const kb = await db.getKnowledgeBase(kb_id);
    if (!kb) throw new Error(`Knowledge Base ${kb_id} not found`);

    let filePath = knowledgeFilePath(kb, name);

    // Ensure parent directories exist
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Handle duplicate names if no directory structure is provided (or even if it is)
    if (fs.existsSync(filePath)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      const dir = path.dirname(name);
      let counter = 1;

      while (fs.existsSync(filePath)) {
        const newName =
          dir === '.'
            ? `${base} (${counter})${ext}`
            : path.join(dir, `${base} (${counter})${ext}`);
        filePath = path.join(kb.folder_path, newName);
        counter++;
      }
    }

    fs.writeFileSync(filePath, content);

    const relativePath = path.relative(kb.folder_path, filePath);
    try {
      await db.updateKnowledgeDocumentMetadata(kb_id, relativePath, {
        ...rowMetadata,
        tags: normalizedTags,
        addedAt: new Date(),
      });
    } catch (err) {
      fs.unlinkSync(filePath);
      throw err;
    }

    // Auto-index in background
    trackBackgroundWork('indexing job', () =>
      this.indexFile(kb_id, filePath),
    ).catch((err) => {
      logger.error({ err, kb_id, filePath }, 'Background auto-indexing failed');
    });

    return relativePath;
  }

  /** Generate a descriptive filename from content using an LLM */
  static async generateFilename(
    content: string,
    group_folder?: string,
  ): Promise<string> {
    const group = group_folder ? getGroupByFolder(group_folder) : undefined;
    const agentConfig = resolveRuntimeSelection(
      group?.settings?.chatRuntimeSelection ||
        getDefaultRuntimeSelection('chat'),
    );
    const agentId = agentConfig.id;
    const baseUrl = directLlmEndpoint(agentConfig);

    const prompt = `Generate a concise, descriptive filename (slugified) for a markdown file with this content.
Reply with ONLY the filename slug, no extension, no spaces.

CONTENT:
${content.substring(0, 2000)}

FILENAME SLUG:`;

    if (baseUrl && agentConfig.model)
      try {
        const response = await runDirectLlm(
          'You are a helpful assistant that generates descriptive filenames.',
          prompt,
          agentConfig.model,
          () => {},
          [],
          [],
          {
            wireApi: agentConfig?.wireApi,
            temperature: 0.1,
            max_tokens: 20,
            baseUrl,
            apiKey:
              agentConfig?.apiKey ||
              agentConfig?.env?.OPENAI_API_KEY ||
              agentConfig?.env?.ANTHROPIC_API_KEY,
            fallback: directLlmFallbackOption(agentConfig),
            agent_id: agentId,
            privacy: { projectId: group_folder, purpose: 'helper' },
          },
        );

        const slug =
          response.result
            ?.trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') || 'note';

        return `${slug}.md`;
      } catch (err) {
        logger.warn(
          { err },
          'AI filename generation failed, falling back to simple slug',
        );
      }
    const firstLine = content
      .split('\n')[0]
      .replace(/[#*`]/g, '')
      .trim()
      .substring(0, 40);
    const slug =
      firstLine
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'note';
    return `${slug}.md`;
  }

  private static readonly URL_REGEX = /https?:\/\/[^\s<>()\[\]"'`]+/g;

  /** Extract unique http(s) URLs from free text (including markdown links) */
  private static extractUrls(text: string): string[] {
    const matches = text.match(this.URL_REGEX) || [];
    // Strip trailing punctuation and markdown emphasis (_ *) that commonly cling to URLs
    const cleaned = matches.map((u) =>
      u.replace(/[.,;:!?)\]}>'"_*]+$/, '').trim(),
    );
    return Array.from(new Set(cleaned.filter(Boolean)));
  }

  /** Pull the first real heading/title out of a cached page's markdown (skips the "> Source:" line) */
  private static extractPageTitle(markdown: string): string | null {
    const lines = markdown.split('\n').slice(0, 40);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('>')) continue;
      const heading = t.match(/^#{1,6}\s+(.+)/);
      if (!heading) continue;
      // Skip breadcrumb headings such as "Computer Science > Machine Learning"
      if (heading[1].includes(' > ')) continue;
      const title = heading[1].replace(/^title:\s*/i, '').trim();
      if (title) return title;
    }
    return null;
  }

  /** The URL when it parses and is http(s), else null */
  private static httpUrlOrNull(url: string | null): string | null {
    if (!url) return null;
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  /** Slugify arbitrary text into a filename-safe slug */
  private static slugify(raw: string): string {
    return raw
      .replace(/^#{1,6}\s+/, '') // strip heading markers
      .replace(/[*`_>~]/g, '') // strip inline markdown
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown links -> their text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 60)
      .replace(/-$/, '');
  }

  /** Generic section headings that make terrible filenames */
  private static readonly GENERIC_TITLES = new Set([
    'tldr',
    'tl-dr',
    'summary',
    'overview',
    'introduction',
    'intro',
    'notes',
    'note',
    'conclusion',
    'abstract',
    'results',
    'background',
    'details',
  ]);

  /** Link shorteners whose URLs say nothing about the target */
  private static readonly SHORTENER_HOSTS = new Set([
    'share.google',
    'goo.gl',
    'bit.ly',
    't.co',
    'tinyurl.com',
    'lnkd.in',
    'buff.ly',
    'ow.ly',
    'is.gd',
  ]);

  /** Opaque random-looking token: 8+ alphanumerics mixing digits, upper and lower case */
  private static isOpaqueToken(segment: string): boolean {
    return (
      /^[A-Za-z0-9]{8,}$/.test(segment) &&
      /\d/.test(segment) &&
      /[A-Z]/.test(segment) &&
      /[a-z]/.test(segment)
    );
  }

  /** Derive a human title slug from a URL's last meaningful path segment (e.g. npm package name) */
  private static titleFromUrl(url: string): string {
    try {
      const u = new URL(url);
      if (this.SHORTENER_HOSTS.has(u.hostname.replace(/^www\./, ''))) return '';
      const segs = u.pathname
        .split('/')
        .map((s) => decodeURIComponent(s).trim())
        .filter(Boolean);
      // Route words that are not the actual subject of the link
      const routeWords = new Set([
        'package',
        'packages',
        'p',
        'dp',
        'article',
        'articles',
        'post',
        'posts',
        'blog',
        'watch',
        'status',
        'wiki',
        'docs',
        'doc',
      ]);
      for (let i = segs.length - 1; i >= 0; i--) {
        const candidate = segs[i]
          .replace(/\.(html?|php|aspx?|md)$/i, '')
          .replace(/^@/, '');
        if (
          candidate &&
          !routeWords.has(candidate.toLowerCase()) &&
          !/^\d+$/.test(candidate) &&
          !this.isOpaqueToken(candidate)
        ) {
          return this.slugify(candidate);
        }
      }
      // No useful path segment → use the domain name (e.g. "example" from www.example.com)
      return this.slugify(u.hostname.replace(/^www\./, '').split('.')[0]);
    } catch {
      return '';
    }
  }

  /**
   * Build a concise, descriptive filename slug. Priority:
   *   1. A cached linked article's own title (instant)
   *   2. The subject of a shared link, derived from its URL (instant) — this is the
   *      strongest signal when the user saves a "here's the article" message
   *   3. A short LLM title, only when the message has no links at all
   *   4. The first non-generic heading / line (skips "TL;DR", "Summary", …)
   * Also returns the document metadata the message supplies: the cached page's
   * title and its URL, else no title and the first URL in the message.
   */
  private static async generateTitleSlug(
    content: string,
    sources: { url: string; markdown: string }[],
    group_folder?: string,
  ): Promise<{
    slug: string;
    title: string | null;
    sourceUrl: string | null;
  }> {
    const urls = this.extractUrls(content);
    const plain = (slug: string) => ({
      slug,
      title: null,
      sourceUrl: urls[0] ?? null,
    });

    // 1. Reuse a cached linked article's own title
    for (const s of sources) {
      const title = this.extractPageTitle(s.markdown);
      const slug = title ? this.slugify(title) : '';
      if (title && slug && !this.GENERIC_TITLES.has(slug))
        return { slug, title: title.substring(0, 200), sourceUrl: s.url };
    }

    // 2. Derive the title from a shared link's URL (instant, no LLM)
    for (const url of urls) {
      const slug = this.titleFromUrl(url);
      if (slug && !this.GENERIC_TITLES.has(slug)) return plain(slug);
    }

    // 3. No links to name the note after → ask the chat agent for a short title
    if (urls.length === 0) {
      const group = group_folder ? getGroupByFolder(group_folder) : undefined;
      const agentConfig = resolveRuntimeSelection(
        group?.settings?.chatRuntimeSelection ||
          getDefaultRuntimeSelection('chat'),
      );
      const agentId = agentConfig.id;
      const baseUrl = directLlmEndpoint(agentConfig);
      const prompt = `Write a short, specific title (3 to 7 words) describing the main topic of the text below. Do not answer with generic words like "Summary" or "TL;DR". Reply with ONLY the title — no quotes, no surrounding punctuation.

TEXT:
${content.substring(0, 3000)}`;
      if (baseUrl && agentConfig.model)
        try {
          const response = await runDirectLlm(
            'You generate short, descriptive document titles.',
            prompt,
            agentConfig.model,
            () => {},
            [],
            [],
            {
              wireApi: agentConfig?.wireApi,
              temperature: 0.2,
              max_tokens: 24,
              baseUrl,
              apiKey:
                agentConfig?.apiKey ||
                agentConfig?.env?.OPENAI_API_KEY ||
                agentConfig?.env?.ANTHROPIC_API_KEY,
              agent_id: agentId,
              fallback: directLlmFallbackOption(agentConfig),
              privacy: { projectId: group_folder, purpose: 'helper' },
            },
          );
          const slug = this.slugify(response.result || '');
          if (slug && !this.GENERIC_TITLES.has(slug)) return plain(slug);
        } catch (err) {
          logger.warn(
            { err },
            'generateTitleSlug: LLM title generation failed, using fallback',
          );
        }
    }

    // 4. Deterministic fallback: first non-generic heading, else first line
    const lines = content
      .split('\n')
      .map((l) => l.replace(this.URL_REGEX, '').trim())
      .filter(Boolean);
    const headings = lines
      .filter((l) => /^#{1,6}\s+/.test(l))
      .map((l) => this.slugify(l))
      .filter((s) => s && !this.GENERIC_TITLES.has(s));
    if (headings.length > 0) return plain(headings[0]);

    const firstLine =
      lines.find((l) => !/^#{1,6}\s/.test(l)) || lines[0] || 'note';
    return plain(this.slugify(firstLine) || 'note');
  }

  /**
   * Save a chat message to a KB. Fast path: stores the original message and, for
   * any web links in it that were already fetched earlier in the chat, their
   * cached page transcript. No live re-fetching and no LLM calls. The filename is
   * derived directly from the message. Returns the saved relative path.
   */
  static async saveEnrichedNote(
    kb_id: string,
    content: string,
    group_folder?: string,
  ): Promise<string> {
    // 1. Reuse cached page transcripts for shared links (skip uncached — keeps it instant)
    const sources = this.extractUrls(content)
      .map((url) => ({ url, markdown: getCachedWebView(url) }))
      .filter((s): s is { url: string; markdown: string } => !!s.markdown);

    // 2. Compose the markdown document: Transcript + cached Sources
    const parts: string[] = [
      `> Saved from chat on ${new Date().toISOString()}`,
    ];
    parts.push(`## Transcript\n\n${content}`);
    if (sources.length > 0) {
      const blocks = sources
        .map((s) => `### ${s.url}\n\n${s.markdown.trim()}`)
        .join('\n\n---\n\n');
      parts.push(`## Sources\n\n${blocks}`);
    }
    const fileContent = parts.join('\n\n');

    // 3. Persist (triggers background indexing inside addFile)
    const { slug, title, sourceUrl } = await this.generateTitleSlug(
      content,
      sources,
      group_folder,
    );
    return await this.addFile(
      kb_id,
      `${slug}.md`,
      Buffer.from(fileContent),
      [],
      { title, sourceUrl: this.httpUrlOrNull(sourceUrl) },
    );
  }

  /** Delete a file from a KB */
  static async deleteFile(kb_id: string, name: string): Promise<void> {
    const kb = await db.getKnowledgeBase(kb_id);
    if (!kb) throw new Error(`Knowledge Base ${kb_id} not found`);

    const filePath = knowledgeFilePath(kb, name);
    const thumbnails = siblingThumbnails(filePath);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const relativePath = path.relative(kb.folder_path, filePath);
    await db.deleteKnowledgeDocument(kb_id, relativePath);
    const removedPaths = [relativePath];
    // A shared basename (e.g. article.md and article.pdf) keeps its image until the last document is removed.
    if (thumbnails.length && !hasSiblingDocument(filePath)) {
      for (const thumbnail of thumbnails) {
        fs.unlinkSync(thumbnail);
        const thumbnailName = path.relative(kb.folder_path, thumbnail);
        await db.deleteKnowledgeDocument(kb_id, thumbnailName);
        removedPaths.push(thumbnailName);
      }
    }
    for (const removedPath of removedPaths) {
      try {
        await deleteKnowledgeFileVectors(kb_id, removedPath);
      } catch (err) {
        logger.error(
          { err, kb_id, path: removedPath },
          'Failed to delete knowledge file vectors',
        );
      }
    }
  }

  /** Index a knowledge base completely */
  static async indexKB(kb_id: string): Promise<void> {
    const kb = await db.getKnowledgeBase(kb_id);
    if (!kb) throw new Error(`Knowledge Base ${kb_id} not found`);

    logger.info(
      { kb_id, name: kb.name },
      'Starting full Knowledge Base indexing',
    );

    // Clear ALL existing vectors for this KB first to remove chunks for deleted files
    try {
      await deleteKnowledgeBaseVectors(kb_id);
    } catch (err) {
      logger.warn(
        { err, kb_id },
        'Failed to clear KB vectors before re-indexing (continuing anyway)',
      );
    }

    const files = await this.listFiles(kb_id);
    for (const { name } of files) {
      const file = path.join(kb.folder_path, name);
      try {
        await this.indexFile(kb_id, file);
      } catch (err) {
        logger.error(
          { err, kb_id, file },
          'Failed to index individual file during KB indexing (skipping)',
        );
      }
    }

    logger.info({ kb_id }, 'Knowledge Base indexing completed');
  }

  /** Index a single file in a Knowledge Base */
  static async indexFile(kb_id: string, filePath: string): Promise<void> {
    const kb = await db.getKnowledgeBase(kb_id);
    if (!kb) throw new Error(`Knowledge Base ${kb_id} not found`);

    const relativePath = path.relative(kb.folder_path, filePath);

    // Skip hidden files (like .DS_Store or our own .filename.md caches)
    if (path.basename(filePath).startsWith('.')) return;

    // Ensure file still exists (it might have been deleted since the scan started)
    if (!fs.existsSync(filePath)) {
      logger.warn(
        { filePath, kb_id },
        'Skipping indexing: File no longer exists',
      );
      return;
    }

    // 1. Clean up old chunks for this file to prevent duplicates
    try {
      await deleteKnowledgeFileVectors(kb_id, relativePath);
    } catch (err) {
      logger.warn(
        { err, kb_id, relativePath },
        'Failed to clear old file vectors during indexing',
      );
    }

    // 2. Extract and chunk
    try {
      if (isThumbnailImage(filePath) && hasSiblingDocument(filePath)) return;
      // An image uploaded before its document may already have been indexed.
      for (const thumbnail of siblingThumbnails(filePath)) {
        await deleteKnowledgeFileVectors(
          kb_id,
          path.relative(kb.folder_path, thumbnail),
        );
      }
      const markdown = await this.convertToMarkdown(filePath);

      // Save extracted text for non-markdown files
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') {
        const cachePath = path.join(
          path.dirname(filePath),
          `.${path.basename(filePath)}.md`,
        );
        fs.writeFileSync(cachePath, markdown);
      }

      const chunks = chunkMarkdown(markdown);

      for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i];
        const embedding = await embedText(content);
        if (embedding) {
          const chunkId = knowledgeChunkId(kb_id, relativePath, i);
          await upsertKnowledgeChunkVector(chunkId, kb_id, content, embedding, {
            source: relativePath,
            index: i,
          });
        } else {
          logger.warn(
            { filePath, index: i },
            'Skipping chunk: Embedding failed',
          );
        }
      }

      await db.updateKnowledgeBase(kb_id, { last_indexed_at: Date.now() });
    } catch (err) {
      if ((err as any)?.code === 'ENOENT') {
        logger.warn(
          { filePath },
          'Indexing skipped: File vanished during extraction (likely moved or deleted)',
        );
      } else {
        logger.error(
          { err, filePath },
          'Failed to index file in Knowledge Base',
        );
        throw err;
      }
    }
  }

  /** Search knowledge across shared KBs for a project */
  static async searchKnowledge(
    group_folder: string,
    query: string,
    limit = 5,
    kb_id?: string,
    kb_name?: string,
    tags: string[] = [],
    verify = false,
    allowedKbIds?: readonly string[],
    privacyProjectId: string = group_folder,
  ): Promise<KnowledgeChunk[]> {
    const shared = await db.getSharedKnowledgeBases(group_folder);
    return this.searchKnowledgeInBases(
      allowedKbIds
        ? shared.filter((kb) => allowedKbIds.includes(kb.id))
        : shared,
      query,
      limit,
      kb_id,
      kb_name,
      tags,
      privacyProjectId,
      verify,
    );
  }

  /** Search one KB from the authenticated Knowledge Hub context. */
  static async searchKnowledgeBase(
    kb_id: string,
    query: string,
    limit = 5,
    tags: string[] = [],
    verify = false,
  ): Promise<KnowledgeChunk[]> {
    const kb = await db.getKnowledgeBase(kb_id);
    return this.searchKnowledgeInBases(
      kb ? [kb] : [],
      query,
      limit,
      kb_id,
      undefined,
      tags,
      undefined,
      verify,
    );
  }

  /** Runs the search and emits one counts-only `knowledge_search` log line. */
  private static async searchKnowledgeInBases(
    kbs: KnowledgeBase[],
    query: string,
    limit: number,
    kb_id?: string,
    kb_name?: string,
    tags: string[] = [],
    group_folder?: string,
    verify = false,
  ): Promise<KnowledgeChunk[]> {
    const startedAt = Date.now();
    const telemetry: KnowledgeSearchTelemetry = {
      project: group_folder ?? null,
      kbCount: kbs.length,
      tagFiltered: false,
      embedded: false,
      vectorHits: null,
      afterMetadataFilter: 0,
      path: 'none',
      keywordHits: null,
      returned: 0,
      topScore: null,
      minReturnedScore: null,
      verify,
      verifiedCount: null,
    };
    let results: KnowledgeChunk[] | undefined;
    try {
      results = await this.runKnowledgeSearch(
        telemetry,
        kbs,
        query,
        limit,
        kb_id,
        kb_name,
        tags,
        group_folder,
        verify,
      );
      return results;
    } finally {
      try {
        if (results) {
          telemetry.returned = results.length;
          const scores = results
            .map((chunk) => (chunk as { score?: unknown }).score)
            .filter((score): score is number => typeof score === 'number');
          if (scores.length > 0) {
            telemetry.topScore = roundScore(Math.max(...scores));
            telemetry.minReturnedScore = roundScore(Math.min(...scores));
          }
        } else {
          telemetry.failed = true;
        }
        logger.info(
          {
            event: 'knowledge_search',
            ...telemetry,
            durationMs: Date.now() - startedAt,
          },
          'knowledge_search',
        );
      } catch {
        // Telemetry must never affect the search outcome.
      }
    }
  }

  private static async runKnowledgeSearch(
    telemetry: KnowledgeSearchTelemetry,
    kbs: KnowledgeBase[],
    query: string,
    limit: number,
    kb_id: string | undefined,
    kb_name: string | undefined,
    tags: string[],
    group_folder: string | undefined,
    verify: boolean,
  ): Promise<KnowledgeChunk[]> {
    const selectedTags = normalizeKnowledgeTags(tags);
    telemetry.tagFiltered = selectedTags.length > 0;
    if (kbs.length === 0) {
      telemetry.reason = 'no_kbs';
      return [];
    }

    if (kb_id) {
      kbs = kbs.filter((kb) => kb.id === kb_id);
    } else if (kb_name) {
      kbs = kbs.filter((kb) => kb.name.toLowerCase() === kb_name.toLowerCase());
    }

    telemetry.kbCount = kbs.length;
    if (kbs.length === 0) {
      telemetry.reason = 'kb_filter_empty';
      return [];
    }

    const kbIds = kbs.map((kb) => kb.id);
    const filesByKb = new Map(
      await Promise.all(
        kbs.map(async (kb) => [kb.id, await this.listFiles(kb.id)] as const),
      ),
    );
    const matchingFiles = new Map(
      [...filesByKb].map(([id, files]) => [
        id,
        files.filter((file) => matchesKnowledgeTags(file.tags, selectedTags)),
      ]),
    );
    const allowedSources = selectedTags.length
      ? [...matchingFiles].flatMap(([kbId, files]) =>
          files.map((file) => ({ kbId, path: file.name })),
        )
      : undefined;
    if (allowedSources?.length === 0) {
      telemetry.reason = 'tag_filter_empty';
      return [];
    }
    const queryEmbedding = await embedText(query, {
      projectId: group_folder,
    });
    telemetry.embedded = queryEmbedding != null;
    let candidates: any[] = [];

    if (queryEmbedding) {
      // Stage 1: Recall (Vector Search)
      candidates = await searchKnowledgeSimilar(
        kbIds,
        queryEmbedding,
        limit * 4,
        allowedSources,
      );
      telemetry.vectorHits = candidates.length;
    }

    // Metadata is authoritative even when the vector index is stale or unavailable.
    const currentFiles = new Map(
      [...matchingFiles].map(([id, files]) => [
        id,
        new Map(files.map((file) => [file.name, file])),
      ]),
    );
    candidates = candidates
      .filter((candidate) =>
        currentFiles
          .get(candidate.knowledge_base_id)
          ?.has(candidate.metadata.source),
      )
      .map((candidate) => ({
        ...candidate,
        metadata: {
          ...candidate.metadata,
          tags: currentFiles
            .get(candidate.knowledge_base_id)!
            .get(candidate.metadata.source)!.tags,
        },
      }));

    telemetry.afterMetadataFilter = candidates.length;
    if (candidates.length > 0) telemetry.path = 'vector';

    // Fallback: If vector store is disabled, or embedding failed, or no vector matches were found:
    // Do keyword / substring match against the files in the KB
    if (candidates.length === 0) {
      logger.info(
        'Falling back to keyword/substring match for knowledge search',
      );
      const queryLower = query.toLowerCase();
      const queryWords = queryLower
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean);
      const longQueryWords = queryWords.filter((w) => w.length > 2);
      const searchWords =
        longQueryWords.length > 0 ? longQueryWords : queryWords;

      for (const kb of kbs) {
        const files = matchingFiles.get(kb.id) || [];
        for (const file of files) {
          const filePath = path.join(kb.folder_path, file.name);
          try {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.md' || ext === '.txt') {
              const text = fs.readFileSync(filePath, 'utf-8');
              const chunks = chunkMarkdown(text);
              for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const contentLower = chunk.toLowerCase();
                const hasFullMatch = contentLower.includes(queryLower);
                const matchedWords = searchWords.filter((w) =>
                  contentLower.includes(w),
                );
                const matchCount = matchedWords.length;

                if (hasFullMatch || matchCount > 0) {
                  const score = hasFullMatch
                    ? 1.0
                    : matchCount / searchWords.length;
                  candidates.push({
                    id: knowledgeChunkId(kb.id, file.name, i),
                    content: chunk,
                    knowledge_base_id: kb.id,
                    metadata: { source: file.name, index: i, tags: file.tags },
                    score,
                  });
                }
              }
            }
          } catch (err) {
            logger.warn(
              { err, filePath },
              'Fallback search failed to read file',
            );
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      telemetry.keywordHits = candidates.length;
      if (candidates.length > 0) telemetry.path = 'keyword';
    }

    if (candidates.length === 0) {
      telemetry.reason = 'no_candidates';
      return [];
    }

    if (!verify) return candidates.slice(0, limit);

    // The jev engine depends only on JEV_URL, never on the group's chat runtime.
    const jevEngine = KNOWLEDGE_VERIFY_ENGINE === 'jev';
    const group = group_folder ? getGroupByFolder(group_folder) : undefined;
    const agentConfig = jevEngine
      ? undefined
      : resolveRuntimeSelection(
          group?.settings?.chatRuntimeSelection ||
            getDefaultRuntimeSelection('chat'),
        );

    // Stage 2: Precision (Verifier)
    const verifiedResults: KnowledgeChunk[] = [];

    for (const candidate of candidates as any[]) {
      try {
        const isMatch = await this.verifyChunk(
          query,
          candidate.content,
          agentConfig,
          group_folder,
        );
        if (isMatch) {
          verifiedResults.push(candidate);
          if (verifiedResults.length >= limit) break;
        }
      } catch (err) {
        if (jevEngine) {
          logger.warn({ err }, 'Chunk verification failed, dropping chunk');
          continue;
        }
        logger.warn(
          { err },
          'Chunk verification failed, falling back to MATCH',
        );
        verifiedResults.push(candidate);
        if (verifiedResults.length >= limit) break;
      }
    }

    telemetry.verifiedCount = verifiedResults.length;

    // If verification filtered out ALL results, fall back to returning the original
    // candidates. The jev engine fails closed instead: nothing verified, nothing returned.
    if (!jevEngine && verifiedResults.length === 0 && candidates.length > 0) {
      logger.info(
        'Verifier rejected all candidates, returning candidates without precision verification',
      );
      return candidates.slice(0, limit);
    }

    return verifiedResults;
  }

  /** Jev engine: one `noul` question whose instructions port the LLM verifier prompt. */
  private static async verifyChunkWithJev(
    query: string,
    chunk: string,
    projectId?: string,
  ): Promise<boolean> {
    try {
      const { answers } = await jevSystemOne({
        projectId,
        state: `QUERY: "${query}"\nDOCUMENT CHUNK: "${chunk.substring(0, 2000)}"`,
        questions: {
          match: {
            type: 'noul',
            instructions:
              "Does the chunk contain information that matches the query's meaning? Watch for structural mismatches (negation flips or role reversals).",
            criteria: {
              true: "The chunk contains information matching the query's meaning",
              false:
                'The chunk does not match the query, including negation flips or role reversals',
            },
          },
        },
      });
      const probability = answers.match?.noul;
      return (
        isProbability(probability) &&
        probability >= KNOWLEDGE_VERIFY_JEV_THRESHOLD
      );
    } catch (err) {
      logger.warn({ err }, 'Jev chunk verification failed, dropping chunk');
      return false;
    }
  }

  private static async verifyChunk(
    query: string,
    chunk: string,
    agentConfig?: any,
    projectId?: string,
  ): Promise<boolean> {
    if (KNOWLEDGE_VERIFY_ENGINE === 'jev') {
      return this.verifyChunkWithJev(query, chunk, projectId);
    }
    const baseUrl = directLlmEndpoint(agentConfig);
    if (!baseUrl) return true;
    const prompt = `You are a high-precision retrieval verifier. 
Your task is to determine if the following document chunk accurately matches the search query's intent, specifically watching out for structural mismatches (negation flips or role reversals).

QUERY: "${query}"
DOCUMENT CHUNK: "${chunk.substring(0, 2000)}"

Does the chunk contain information that matches the query's meaning?
Reply with ONLY "MATCH" or "MISMATCH".`;

    try {
      const response = await runDirectLlm(
        'You are a high-precision verifier. Respond only with MATCH or MISMATCH.',
        prompt,
        agentConfig.model,
        () => {},
        [],
        [],
        {
          wireApi: agentConfig?.wireApi,
          baseUrl,
          apiKey:
            agentConfig?.apiKey ||
            agentConfig?.env?.OPENAI_API_KEY ||
            agentConfig?.env?.ANTHROPIC_API_KEY,
          temperature: 0,
          max_tokens: 10,
          fallback: directLlmFallbackOption(agentConfig),
          privacy: { projectId, purpose: 'knowledge_verify' },
        },
      );

      const resultText = response.result || '';
      return (
        resultText.trim().toUpperCase().includes('MATCH') &&
        !resultText.trim().toUpperCase().includes('MISMATCH')
      );
    } catch (err) {
      logger.warn({ err }, 'Verification step failed, falling back to MATCH');
      return true;
    }
  }

  private static async convertToMarkdown(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.md' || ext === '.txt') {
      return fs.readFileSync(filePath, 'utf-8');
    }

    if (ext === '.pdf') {
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: dataBuffer });
        const result = await parser.getText();
        await parser.destroy();
        return result.text;
      } catch (err) {
        logger.error({ err, filePath }, 'Failed to extract text from PDF');
        throw new Error(
          `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const proc = spawn('python3', ['scripts/docling-wrapper.py', filePath]);
        let stdout = '';
        let stderr = '';

        proc.on('error', (err: any) => {
          if (err.code === 'ENOENT') {
            reject(
              new Error(
                'Python 3 is not installed in the container. PDF/Office document conversion via Docling is unavailable. Using lightweight fallback for PDFs.',
              ),
            );
          } else {
            reject(err);
          }
        });

        proc.stdout.on('data', (data) => (stdout += data));
        proc.stderr.on('data', (data) => (stderr += data));
        proc.on('close', (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr || `Docling failed with code ${code}`));
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}
