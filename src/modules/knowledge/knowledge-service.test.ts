import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { initDatabase } from '../../db.js';
import * as db from './db-kb.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { knowledgeDocuments, projects, users } from '../../db/schema.js';
import { KnowledgeService } from './knowledge-service.js';
import * as vectors from '../vector-store/store.js';
import * as directLlmModule from '../chat/direct-llm.js';
import * as jevClient from '../../lib/jev-client.js';
import * as chatAgents from '../../lib/chat-agents.js';
import * as webProxy from '../web/proxy.js';
import {
  list_knowledge_tags,
  list_knowledge_documents,
  read_knowledge_document,
  update_knowledge_document,
  save_to_knowledge,
} from './tools.js';

import express from 'express';
import { groupArtifactsDir } from '../chat/artifacts.js';
import { getKnowledgeRouter } from './routes.js';
import { requiredDeviceScopes } from '../../lib/device-auth/policy.js';
import { createSigningPayload, verifySignature } from '../../crypto-verify.js';

async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  return Buffer.from(await crypto.subtle.exportKey('spki', key)).toString(
    'base64',
  );
}

async function signPayload(key: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(payload),
  );
  return Buffer.from(signature).toString('base64');
}

function clientSigningPayload(
  method: string,
  url: string,
  timestamp: string,
  body = '',
): string {
  let requestPath = url;
  try {
    if (url.startsWith('http')) {
      const parsed = new URL(url);
      requestPath = parsed.pathname + parsed.search;
    }
  } catch {
    requestPath = url;
  }
  return `${timestamp}:${method}:${requestPath}:${body || ''}`;
}

function knowledgeDocumentUrl(
  kbId: string,
  filename: string,
  kind: 'content' | 'thumbnail',
): string {
  return `/api/knowledge/${encodeURIComponent(kbId)}/files/${kind}?${new URLSearchParams({ filename })}`;
}

// Protect the new core behavior: tags restrict retrieval without losing KB isolation.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-tags-'));
const group = `tags-${path.basename(root)}`;
const kbIds: string[] = [];
// The 'viewer' caller in the signed-proxy tests is a real user with a
// user-level KB membership (kb_members.user_id -> users.id). It is
// deliberately not the project: project shares live in
// knowledge_base_shares and are granted per project folder.
const viewerId = `kb-viewer-${path.basename(root)}`;

beforeAll(async () => {
  await initDatabase(':memory:');
  await drizzleDbRef.current.insert(users).values({
    id: viewerId,
    username: viewerId,
    password_hash: 'unused',
    created_at: new Date().toISOString(),
  });
  // Project shares live in knowledge_base_shares, whose group_folder
  // references projects.id, so the test group must exist as a project.
  await drizzleDbRef.current.insert(projects).values({
    id: group,
    jid: `${group}@web`,
    name: group,
    folder: group,
    trigger: '!',
    added_at: new Date().toISOString(),
  });
});
afterEach(() => mock.restore());
afterAll(async () => {
  for (const id of kbIds) await db.deleteKnowledgeBase(id);
  await drizzleDbRef.current.delete(projects).where(eq(projects.id, group));
  await drizzleDbRef.current.delete(users).where(eq(users.id, viewerId));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(groupArtifactsDir(group), { recursive: true, force: true });
});

async function makeKB(label: string, shared = true) {
  const id = `${group}-${label}`;
  const folder = path.join(root, label);
  fs.mkdirSync(folder, { recursive: true });
  await db.createKnowledgeBase({
    id,
    name: label,
    description: null,
    folder_path: folder,
    created_at: Date.now(),
    last_indexed_at: null,
  });
  kbIds.push(id);
  if (shared) await db.shareKnowledgeBase(id, group);
  return { id, folder };
}

describe('knowledge document tags', () => {
  test('persist against saved paths, survive reindex, and clean up on deletion', async () => {
    const kb = await makeKB('storage');
    const indexing = spyOn(KnowledgeService, 'indexFile').mockResolvedValue(
      undefined,
    );
    const removeVectors = spyOn(
      vectors,
      'deleteKnowledgeFileVectors',
    ).mockResolvedValue(undefined);
    spyOn(vectors, 'deleteKnowledgeBaseVectors').mockResolvedValue(undefined);
    fs.writeFileSync(
      path.join(kb.folder, 'legacy.md'),
      'untagged legacy document',
    );
    const first = await KnowledgeService.addFile(
      kb.id,
      'one/article.md',
      Buffer.from('research'),
      [' AI ', 'ai', 'Research'],
    );
    const second = await KnowledgeService.addFile(
      kb.id,
      'one/article.md',
      Buffer.from('other'),
      ['Other'],
    );
    const nested = await KnowledgeService.addFile(
      kb.id,
      'two/article.md',
      Buffer.from('nested'),
      ['AI'],
    );
    expect(second).toBe('one/article (1).md');
    expect(
      (await KnowledgeService.listFiles(kb.id)).find(
        (file) => file.name === first,
      )?.tags,
    ).toEqual(['AI', 'Research']);
    expect(
      (await KnowledgeService.listFiles(kb.id)).find(
        (file) => file.name === 'legacy.md',
      )?.tags,
    ).toEqual([]);
    expect(await KnowledgeService.listTags(kb.id)).toContainEqual({
      name: 'AI',
      count: 2,
    });
    const thumbnail = await KnowledgeService.addFile(
      kb.id,
      'one/article.png',
      Buffer.from('thumbnail fixture'),
    );
    expect(
      (await KnowledgeService.listFiles(kb.id)).find(
        (file) => file.name === first,
      )?.thumbnail?.name,
    ).toBe(thumbnail);
    expect(
      (await KnowledgeService.listFiles(kb.id)).some(
        (file) => file.name === thumbnail,
      ),
    ).toBe(false);
    expect(
      (await KnowledgeService.listFiles(kb.id)).find(
        (file) => file.name === nested,
      )?.thumbnail,
    ).toBeUndefined();
    expect(await KnowledgeService.getThumbnailPath(kb.id, first)).toBe(
      path.join(kb.folder, thumbnail),
    );
    indexing.mockClear();
    await KnowledgeService.updateFileTags(kb.id, first, ['Updated']);
    expect(indexing).not.toHaveBeenCalled();
    indexing.mockRestore();
    spyOn(vectors, 'embedText').mockResolvedValue([1, 0]);
    const upsert = spyOn(
      vectors,
      'upsertKnowledgeChunkVector',
    ).mockResolvedValue(undefined);
    await KnowledgeService.indexKB(kb.id);
    const nestedChunks = upsert.mock.calls.filter(
      (call) => call[4]?.source === first || call[4]?.source === nested,
    );
    expect(new Set(nestedChunks.map((call) => call[0])).size).toBe(2);
    expect(
      upsert.mock.calls.some((call) => call[4]?.source === thumbnail),
    ).toBe(false);
    expect(
      (await db.getKnowledgeDocuments(kb.id)).find((doc) => doc.path === first)
        ?.tags,
    ).toEqual(['Updated']);
    expect(
      (await db.getKnowledgeDocuments(kb.id)).find((doc) => doc.path === nested)
        ?.tags,
    ).toEqual(['AI']);
    await expect(
      KnowledgeService.updateFileTags(kb.id, first, [' ']),
    ).rejects.toThrow();
    await expect(
      KnowledgeService.updateFileTags(kb.id, '../outside.md', ['AI']),
    ).rejects.toThrow();
    await KnowledgeService.deleteFile(kb.id, second);
    expect(removeVectors).toHaveBeenCalledWith(kb.id, second);
    expect(
      (await db.getKnowledgeDocuments(kb.id)).some(
        (doc) => doc.path === second,
      ),
    ).toBe(false);
    await KnowledgeService.deleteFile(kb.id, first);
    expect(fs.existsSync(path.join(kb.folder, thumbnail))).toBe(false);
    expect(
      (await db.getKnowledgeDocuments(kb.id)).some(
        (doc) => doc.path === thumbnail,
      ),
    ).toBe(false);
    await KnowledgeService.deleteKB(kb.id);
    expect(await db.getKnowledgeDocuments(kb.id)).toEqual([]);
  });

  test('restricts semantic and fallback retrieval to all tags in shared KBs and reflects edits immediately', async () => {
    const kb = await makeKB('retrieval');
    const secret = await makeKB('private', false);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    spyOn(KnowledgeService as any, 'verifyChunk').mockResolvedValue(true);
    const embedding = spyOn(vectors, 'embedText').mockResolvedValue([1, 0]);
    await KnowledgeService.addFile(
      kb.id,
      'research/article.md',
      Buffer.from('local model research target'),
      ['AI', 'Research'],
    );
    await KnowledgeService.addFile(
      kb.id,
      'news/article.md',
      Buffer.from('local model news'),
      ['AI'],
    );
    await KnowledgeService.addFile(
      secret.id,
      'research/article.md',
      Buffer.from('local model private'),
      ['AI', 'Research', 'Private'],
    );
    const semantic = spyOn(vectors, 'searchKnowledgeSimilar').mockResolvedValue(
      [
        {
          id: 'matching-chunk',
          knowledge_base_id: kb.id,
          content: 'local model research target',
          score: 0.7,
          metadata: { source: 'research/article.md', tags: ['stale'] },
        },
      ],
    );
    const found = await KnowledgeService.searchKnowledge(
      group,
      'local model',
      1,
      kb.id,
      undefined,
      ['ai', 'RESEARCH'],
    );
    expect(semantic).toHaveBeenLastCalledWith([kb.id], [1, 0], 4, [
      { kbId: kb.id, path: 'research/article.md' },
    ]);
    expect(found.map((chunk) => chunk.metadata.tags)).toEqual([
      ['AI', 'Research'],
    ]);
    embedding.mockResolvedValue(null);
    const fallback = await KnowledgeService.searchKnowledge(
      group,
      'local model',
      5,
      undefined,
      undefined,
      ['AI', 'Research'],
    );
    expect(
      fallback.map((chunk) => [chunk.knowledge_base_id, chunk.metadata.source]),
    ).toEqual([[kb.id, 'research/article.md']]);
    await KnowledgeService.updateFileTags(kb.id, 'research/article.md', ['AI']);
    expect(
      await KnowledgeService.searchKnowledge(
        group,
        'local model',
        5,
        kb.id,
        undefined,
        ['Research'],
      ),
    ).toEqual([]);
    expect(
      await KnowledgeService.searchKnowledge(
        group,
        'local model',
        5,
        secret.id,
        undefined,
        ['AI'],
      ),
    ).toEqual([]);
    expect(
      await KnowledgeService.searchKnowledge(
        group,
        'local model',
        5,
        kb.id,
        undefined,
        ['Unknown'],
      ),
    ).toEqual([]);
    const catalog = JSON.parse(
      await list_knowledge_tags.handler({}, {} as any, { group_folder: group }),
    );
    expect(catalog.some((entry: any) => entry.kbId === secret.id)).toBe(false);
    expect(catalog.find((entry: any) => entry.kbId === kb.id)?.tags).toEqual([
      { name: 'AI', count: 2 },
    ]);
  });
});

// Model a proxy that decodes the path while preserving the raw query string,
// then verifies the device signature against the forwarded URL.
async function startPathNormalizingProxy() {
  const keys = await generateDeviceKeyPair();
  const publicKey = await exportPublicKey(keys.publicKey);
  const app = express();
  app.use(async (req: any, res, next) => {
    const queryStart = req.originalUrl.indexOf('?');
    const pathPart =
      queryStart < 0 ? req.originalUrl : req.originalUrl.slice(0, queryStart);
    const query = queryStart < 0 ? '' : req.originalUrl.slice(queryStart);
    const forwardedUrl = decodeURIComponent(pathPart) + query;
    const timestamp = req.get('x-carapa-timestamp') || '';
    const valid = await verifySignature(
      publicKey,
      req.get('x-carapa-signature') || '',
      createSigningPayload(req.method, forwardedUrl, timestamp, ''),
    );
    if (!valid) return res.status(401).end();
    req.url = forwardedUrl;
    // 'viewer' is a real KB member (granted below by the test); 'unshared' is not.
    const as = req.get('x-test-user');
    req.authUser = as
      ? {
          id: as === 'viewer' ? viewerId : 'unshared-reader',
          role: 'user',
        }
      : { id: 'unshared-reader', role: 'admin' };
    next();
  });
  app.use('/api', getKnowledgeRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (
    url: string,
    method = 'GET',
    as?: 'unshared' | 'viewer',
  ) => {
    const timestamp = new Date().toISOString();
    const signature = await signPayload(
      keys.privateKey,
      clientSigningPayload(method, origin + url, timestamp),
    );
    return fetch(origin + url, {
      method,
      headers: {
        'x-carapa-timestamp': timestamp,
        'x-carapa-signature': signature,
        ...(as ? { 'x-test-user': as } : {}),
      },
    });
  };
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections();
    });
  return { origin, request, close };
}

// A reported 401 exposed missing coverage for signed nested paths through proxies.
test('reads nested documents and thumbnails through a path-normalizing proxy without weakening access checks', async () => {
  const kb = await makeKB('signed-reads');
  const filename = 'carapa-board/MODULES + notes.md';
  fs.mkdirSync(path.join(kb.folder, 'carapa-board'));
  fs.writeFileSync(path.join(kb.folder, filename), '# Modules');
  fs.writeFileSync(
    path.join(kb.folder, 'carapa-board/MODULES + notes.png'),
    'image fixture',
  );
  const { origin, request, close } = await startPathNormalizingProxy();
  try {
    const url = knowledgeDocumentUrl(kb.id, filename, 'content');
    const content = await request(url);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('# Modules');
    const head = await request(url, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('9');
    const thumbnail = await request(
      knowledgeDocumentUrl(kb.id, filename, 'thumbnail') + '&v=1',
    );
    expect(thumbnail.status).toBe(200);
    expect(await thumbnail.text()).toBe('image fixture');
    expect((await request(url, 'GET', 'unshared')).status).toBe(403);
    expect((await fetch(origin + url)).status).toBe(401);
    expect(
      (await request(knowledgeDocumentUrl(kb.id, '../outside.md', 'content')))
        .status,
    ).toBe(400);
  } finally {
    await close();
  }
});

test('deletes nested documents by query filename through a path-normalizing proxy and keeps the policy rule', async () => {
  const kb = await makeKB('signed-delete');
  spyOn(vectors, 'deleteKnowledgeFileVectors').mockResolvedValue(undefined);
  await db.upsertKbMember(viewerId, kb.id, 'viewer');
  fs.mkdirSync(path.join(kb.folder, 'docs'));
  const nested = path.join(kb.folder, 'docs/a.md');
  fs.writeFileSync(nested, '# A');
  const { request, close } = await startPathNormalizingProxy();
  const url = (name: string) =>
    `/api/knowledge/${kb.id}/files?${new URLSearchParams({ filename: name })}`;
  try {
    // Unshared users stop at the KB guard; a viewer member reaches the
    // editor-level check on the route itself.
    expect((await request(url('docs/a.md'), 'DELETE', 'unshared')).status).toBe(
      403,
    );
    const viewer = await request(url('docs/a.md'), 'DELETE', 'viewer');
    expect(viewer.status).toBe(403);
    expect(((await viewer.json()) as { error: string }).error).toContain(
      'Insufficient access level',
    );
    expect(fs.existsSync(nested)).toBe(true);
    expect((await request(url('../outside.md'), 'DELETE')).status).toBe(400);
    expect((await request(url('docs/a.md'), 'DELETE')).status).toBe(200);
    expect(fs.existsSync(nested)).toBe(false);
  } finally {
    await close();
  }
  expect(
    requiredDeviceScopes('DELETE', `/api/knowledge/${kb.id}/files`, {}),
  ).toEqual(['knowledge:delete']);
});

// Exact chat references must resolve without indexing and remain project-scoped.
test('reads exact shared documents in pages and rejects inaccessible paths', async () => {
  const kb = await makeKB('reference-reader');
  const privateKb = await makeKB('private-reference-reader', false);
  fs.mkdirSync(path.join(kb.folder, 'guides'));
  const filename = 'guides/document [draft] & notes.md';
  fs.writeFileSync(path.join(kb.folder, filename), 'first page; second page');
  const read = (kbId: string, name: string, offset = 0) =>
    read_knowledge_document.handler(
      { kb_id: kbId, filename: name, offset, limit: 12 },
      {} as Parameters<typeof read_knowledge_document.handler>[1],
      { group_folder: group },
    );
  const first = JSON.parse(await read(kb.id, filename));
  const second = JSON.parse(await read(kb.id, filename, first.nextOffset));
  expect(first.content + second.content).toBe('first page; second page');
  expect(second.nextOffset).toBeNull();
  await expect(read(privateKb.id, filename)).rejects.toThrow('not shared');
  await expect(read(kb.id, '../outside.md')).rejects.toThrow();
  await expect(read(kb.id, 'missing.md')).rejects.toThrow('Document not found');
});

// Core document editing must preserve persisted fields and project isolation.
test('updates shared documents in place and reads persisted metadata and thumbnails', async () => {
  const kb = await makeKB('document-editor');
  const privateKb = await makeKB('private-editor', false);
  const indexing = spyOn(KnowledgeService, 'indexFile').mockResolvedValue(
    undefined,
  );
  const filename = 'note.md';
  fs.mkdirSync(groupArtifactsDir(group), { recursive: true });
  fs.writeFileSync(
    path.join(groupArtifactsDir(group), 'thumbnail.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  fs.writeFileSync(
    path.join(groupArtifactsDir(group), 'invalid.png'),
    'invalid',
  );
  const indexKB = spyOn(KnowledgeService, 'indexKB').mockResolvedValue(
    undefined,
  );
  await save_to_knowledge.handler(
    {
      kb_id: kb.id,
      filename,
      content: 'Original',
      tags: ['Saved'],
      metadata: {
        title: 'Saved title',
        description: 'Saved description',
        sourceUrl: 'https://example.com/source',
      },
    },
    {} as any,
    { group_folder: group },
  );
  const saved = await KnowledgeService.readDocumentDetails(kb.id, filename);
  expect(saved.metadata).toEqual({
    tags: ['Saved'],
    title: 'Saved title',
    description: 'Saved description',
    sourceUrl: 'https://example.com/source',
    publishedAt: null,
  });
  expect(indexKB).not.toHaveBeenCalled();
  expect(indexing).toHaveBeenCalledTimes(1);
  indexing.mockClear();
  fs.writeFileSync(path.join(kb.folder, 'binary.pdf'), '%PDF-1.7');
  const update = (args: Record<string, unknown>) =>
    update_knowledge_document.handler(
      { kb_id: kb.id, filename, ...args },
      {} as any,
      { group_folder: group },
    );
  await update({
    content: 'Updated document',
    metadata: {
      tags: ['Research', 'research'],
      title: 'Title',
      description: 'Description',
      sourceUrl: 'https://example.com/article',
    },
    thumbnailSourcePath: 'artifacts/thumbnail.png',
  });
  expect(indexing).toHaveBeenCalledTimes(1);
  const read = JSON.parse(
    await read_knowledge_document.handler(
      { kb_id: kb.id, filename },
      {} as any,
      { group_folder: group },
    ),
  );
  expect(read.content).toBe('Updated document');
  expect(read.metadata).toEqual({
    tags: ['Research'],
    title: 'Title',
    description: 'Description',
    sourceUrl: 'https://example.com/article',
    publishedAt: null,
  });
  expect(read.thumbnail.name).toBe('note.png');
  // Complete enumeration is needed before a document-by-document tag migration.
  const list = (kbId: string, offset = 0) =>
    list_knowledge_documents.handler(
      { kb_id: kbId, offset, limit: 1 },
      {} as any,
      { group_folder: group },
    );
  const firstPage = JSON.parse(await list(kb.id));
  expect(firstPage.total).toBe(2);
  expect(firstPage.documents).toEqual([
    {
      filename: 'binary.pdf',
      tags: [],
      title: null,
      description: null,
      sourceUrl: null,
      publishedAt: null,
      addedAt: expect.any(String),
      modifiedAt: expect.any(String),
    },
  ]);
  const secondPage = JSON.parse(await list(kb.id, firstPage.nextOffset));
  expect(secondPage.documents).toEqual([
    {
      filename,
      ...read.metadata,
      addedAt: read.addedAt,
      modifiedAt: read.modifiedAt,
    },
  ]);
  expect(secondPage.nextOffset).toBeNull();
  expect(JSON.parse(await list(kb.id, 2)).documents).toEqual([]);
  await expect(list(privateKb.id)).rejects.toThrow('not shared');

  const patched = JSON.parse(
    await update({ metadata: { title: null, tags: [] } }),
  );
  expect(patched.metadata).toEqual({
    tags: [],
    title: null,
    description: 'Description',
    sourceUrl: 'https://example.com/article',
    publishedAt: null,
  });
  expect(patched.thumbnail.name).toBe('note.png');
  expect(fs.readFileSync(path.join(kb.folder, filename), 'utf8')).toBe(
    'Updated document',
  );
  expect(indexing).toHaveBeenCalledTimes(1);
  await expect(
    update({
      filename: 'binary.pdf',
      content: 'corrupt',
      metadata: { title: 'No' },
    }),
  ).rejects.toThrow('non-binary');
  expect(fs.readFileSync(path.join(kb.folder, 'binary.pdf'), 'utf8')).toBe(
    '%PDF-1.7',
  );
  await update({ filename: 'binary.pdf', metadata: { title: 'PDF title' } });
  const binary = JSON.parse(
    await read_knowledge_document.handler(
      { kb_id: kb.id, filename: 'binary.pdf', metadataOnly: true },
      {} as any,
      { group_folder: group },
    ),
  );
  expect(binary.metadata.title).toBe('PDF title');
  await expect(update({ kb_id: privateKb.id, content: 'No' })).rejects.toThrow(
    'not shared',
  );
  await expect(
    update({ filename: '../escape.md', content: 'No' }),
  ).rejects.toThrow();
  await expect(
    update({
      content: 'No',
      thumbnailSourcePath: 'artifacts/invalid.png',
    }),
  ).rejects.toThrow('PNG');
  expect(fs.readFileSync(path.join(kb.folder, filename), 'utf8')).toBe(
    'Updated document',
  );
  const cleared = JSON.parse(await update({ thumbnailSourcePath: null }));
  expect(cleared.thumbnail).toBeNull();
  expect(fs.existsSync(path.join(kb.folder, 'note.png'))).toBe(false);
  expect(fs.existsSync(path.join(kb.folder, 'note (1).md'))).toBe(false);
});

// Agents review newly added articles: dates must be stable, filterable and backfilled.
test('exposes addedAt, modifiedAt and publishedAt with an added_after filter', async () => {
  const kb = await makeKB('document-dates');
  spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
  const ctx = { group_folder: group };
  const call = async (tool: any, args: Record<string, unknown>) =>
    JSON.parse(await tool.handler({ kb_id: kb.id, ...args }, {} as any, ctx));
  const list = (args: Record<string, unknown> = {}) =>
    call(list_knowledge_documents, args);

  await save_to_knowledge.handler(
    {
      kb_id: kb.id,
      filename: 'a.md',
      content: 'one',
      metadata: { publishedAt: '2024-05-01' },
    },
    {} as any,
    ctx,
  );
  await expect(
    save_to_knowledge.handler(
      {
        kb_id: kb.id,
        filename: 'bad.md',
        content: 'x',
        metadata: { publishedAt: 'not-a-date' },
      },
      {} as any,
      ctx,
    ),
  ).rejects.toThrow();
  expect(fs.existsSync(path.join(kb.folder, 'bad.md'))).toBe(false);
  const first = (await list()).documents[0];
  expect(first.publishedAt).toBe('2024-05-01T00:00:00.000Z');
  const addedAt = Date.parse(first.addedAt);
  expect(Math.abs(Date.now() - addedAt)).toBeLessThan(60_000);

  // Content and metadata edits keep addedAt; modifiedAt follows the file.
  // The edit rewrites the file (mtime = now, possibly the same millisecond as
  // addedAt), so move the mtime afterwards and expect exactly that time.
  await call(update_knowledge_document, {
    filename: 'a.md',
    content: 'two',
    metadata: { title: 'A', publishedAt: '2024-06-02T10:00:00Z' },
  });
  const future = new Date(addedAt + 3_600_000);
  fs.utimesSync(path.join(kb.folder, 'a.md'), future, future);
  const edited = await call(read_knowledge_document, { filename: 'a.md' });
  expect(edited.addedAt).toBe(first.addedAt);
  expect(edited.publishedAt).toBe('2024-06-02T10:00:00.000Z');
  expect(edited.modifiedAt).toBe(future.toISOString());
  await expect(
    call(update_knowledge_document, {
      filename: 'a.md',
      metadata: { publishedAt: '2024-13-45' },
    }),
  ).rejects.toThrow();
  const cleared = await call(update_knowledge_document, {
    filename: 'a.md',
    metadata: { publishedAt: null },
  });
  expect(cleared.publishedAt).toBeNull();
  expect(cleared.addedAt).toBe(first.addedAt);

  // A dropped-in file uses file times; a row created by a metadata write is backfilled once and stays put.
  fs.writeFileSync(path.join(kb.folder, 'dropped.md'), 'dropped');
  fs.writeFileSync(path.join(kb.folder, 'undated.md'), 'undated');
  await db.setKnowledgeDocumentTags(kb.id, 'undated.md', ['old']);
  const undatedBefore = (await list()).documents.find(
    (d: any) => d.filename === 'undated.md',
  );
  expect(Date.parse(undatedBefore.addedAt)).toBeGreaterThan(0);
  const stored = await db.getKnowledgeDocument(kb.id, 'undated.md');
  expect(stored?.addedAt?.toISOString()).toBe(undatedBefore.addedAt);
  const later = new Date(Date.now() + 86_400_000);
  fs.utimesSync(path.join(kb.folder, 'undated.md'), later, later);
  const undatedAfter = (await list()).documents.find(
    (d: any) => d.filename === 'undated.md',
  );
  expect(undatedAfter.addedAt).toBe(undatedBefore.addedAt);
  expect(await db.getKnowledgeDocument(kb.id, 'dropped.md')).toBeUndefined();

  // added_after is strict and applied before pagination.
  await drizzleDbRef.current
    .update(knowledgeDocuments)
    .set({ addedAt: new Date('2020-01-01T00:00:00Z') })
    .where(
      and(
        eq(knowledgeDocuments.kbId, kb.id),
        eq(knowledgeDocuments.path, 'a.md'),
      ),
    );
  expect((await list({ added_after: '2019-12-31' })).total).toBe(3);
  expect((await list({ added_after: '2020-01-01T00:00:00Z' })).total).toBe(2);
  const filtered = await list({ added_after: '2021-01-01', limit: 1 });
  expect(filtered.total).toBe(2);
  expect(filtered.documents).toHaveLength(1);
  expect(filtered.nextOffset).toBe(1);
  expect(filtered.documents[0].filename).toBe('dropped.md');
  expect((await list({ added_after: '2999-01-01' })).documents).toEqual([]);
  await expect(list({ added_after: 'yesterday' })).rejects.toThrow();
});

describe('knowledge helper privacy attribution', () => {
  const remoteAgent = {
    id: 'remote-agent',
    harnessKind: 'direct',
    model: 'remote-model',
    baseUrl: 'https://remote.example/v1',
    apiKey: 'unused',
  };

  test('search attributes the query embedding and verifier to the querying project', async () => {
    const kb = await makeKB('attribution');
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    await KnowledgeService.addFile(
      kb.id,
      'note.md',
      Buffer.from('attributed note'),
    );
    const embedding = spyOn(vectors, 'embedText').mockResolvedValue([1, 0]);
    spyOn(vectors, 'searchKnowledgeSimilar').mockResolvedValue([
      {
        id: 'chunk',
        knowledge_base_id: kb.id,
        content: 'attributed note',
        score: 0.9,
        metadata: { source: 'note.md' },
      },
    ]);
    const verify = spyOn(
      KnowledgeService as any,
      'verifyChunk',
    ).mockResolvedValue(true);

    await KnowledgeService.searchKnowledge(
      group,
      'attributed',
      1,
      kb.id,
      undefined,
      [],
      true,
    );

    expect(embedding).toHaveBeenCalledWith('attributed', { projectId: group });
    expect(verify.mock.calls[0]?.[3]).toBe(group);
    verify.mockRestore();
  });

  test('the verifier passes the querying project to Jev (test env uses the jev engine)', async () => {
    const jev = spyOn(jevClient, 'jevSystemOne').mockResolvedValue({
      answers: { match: { noul: 0.9 } },
    } as any);
    await (KnowledgeService as any).verifyChunk('q', 'chunk', undefined, group);
    expect(jev.mock.calls[0]?.[0]?.projectId).toBe(group);
  });

  test('filename and title generation declare helper purpose for the project', async () => {
    spyOn(chatAgents, 'resolveRuntimeSelection').mockReturnValue(
      remoteAgent as any,
    );
    const directLlm = spyOn(directLlmModule, 'runDirectLlm').mockResolvedValue({
      result: 'a-title',
    } as any);

    await KnowledgeService.generateFilename('some content', group);
    await (KnowledgeService as any).generateTitleSlug(
      'some content without links',
      [],
      group,
    );

    expect(directLlm).toHaveBeenCalledTimes(2);
    for (const call of directLlm.mock.calls) {
      expect(call[6]?.privacy).toEqual({ projectId: group, purpose: 'helper' });
    }
  });
});

describe('chat-save titles and metadata', () => {
  const arxivUrl = 'https://arxiv.org/abs/2610.37364';
  const arxivTitle =
    'EmbeddingGemma 2: Unified and Efficient Multimodal Representations';
  const arxivMarkdown = `> **Source**: ${arxivUrl}

# Computer Science > Machine Learning

**arXiv:2610.37364** (cs)

# Title:${arxivTitle}
`;
  const slugOf = (content: string, sources: any[] = []) =>
    (KnowledgeService as any).generateTitleSlug(content, sources, group);

  test('a breadcrumb heading is skipped and the paper title and URL are returned', async () => {
    const xUrl = 'https://x.com/googlegemma/status/2118382075564929178';
    const result = await slugOf(`${xUrl} ${arxivUrl}`, [
      { url: xUrl, markdown: '> **Source**: x\n\nno heading here' },
      { url: arxivUrl, markdown: arxivMarkdown },
    ]);
    expect(result).toEqual({
      slug: 'embeddinggemma-2-unified-and-efficient-multimodal-representa',
      title: arxivTitle,
      sourceUrl: arxivUrl,
    });
  });

  test('opaque short links never name the note and lose trailing emphasis markers', async () => {
    const shortLink = 'https://share.google/FNH7yE0b9MHvGBbJl';
    expect(
      await slugOf(
        `> **web_view** _${shortLink}_\n\nSee https://huggingface.co/Edge0/Audio8-TTS-Realistic-0.6b`,
      ),
    ).toEqual({
      slug: 'audio8-tts-realistic-0-6b',
      title: null,
      sourceUrl: shortLink,
    });
    expect(await slugOf(shortLink)).toEqual({
      slug: 'note',
      title: null,
      sourceUrl: shortLink,
    });
  });

  test('saveEnrichedNote stores the page title and source URL as metadata', async () => {
    const kb = await makeKB('chat-save-metadata');
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    spyOn(webProxy, 'getCachedWebView').mockImplementation((url: string) =>
      url === arxivUrl ? arxivMarkdown : null,
    );

    const saved = await KnowledgeService.saveEnrichedNote(
      kb.id,
      `https://x.com/googlegemma/status/2118382075564929178 and ${arxivUrl}`,
      group,
    );

    const details = await KnowledgeService.readDocumentDetails(kb.id, saved);
    expect(details.metadata.sourceUrl).toBe(arxivUrl);
    expect(details.metadata.title).toBe(arxivTitle);
  });
});
