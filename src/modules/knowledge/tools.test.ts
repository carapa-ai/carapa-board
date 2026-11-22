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
import { inArray } from 'drizzle-orm';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { users } from '../../db/schema.js';
import { PrivacyRefusal, type PrivacyMode } from '../../lib/privacy-policy.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import * as db from './db-kb.js';
import { KnowledgeService } from './knowledge-service.js';
import {
  list_knowledge_documents,
  read_knowledge_document,
  save_to_knowledge,
  search_knowledge,
  update_knowledge_document,
} from './tools.js';

const prefix = `kb-write-gate-${process.pid}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-write-gate-'));
const jids: string[] = [];
const userIds: string[] = [];
const kbIds: string[] = [];

async function project(name: string, privacyMode: PrivacyMode) {
  const folder = `${prefix}-${name}`;
  const jid = `${folder}@web`;
  jids.push(jid);
  await registerGroup(jid, {
    jid,
    name,
    folder,
    trigger: `@${name}`,
    added_at: new Date().toISOString(),
    settings: { privacyMode },
  });
  userIds.push(`group:${folder}`);
  await drizzleDbRef.current.insert(users).values({
    id: `group:${folder}`,
    username: folder,
    password_hash: 'unused',
    created_at: new Date().toISOString(),
  });
  return folder;
}

async function sharedKb(label: string, folders: string[]) {
  const id = `${prefix}-${label}`;
  const folderPath = path.join(root, label);
  fs.mkdirSync(folderPath, { recursive: true });
  await db.createKnowledgeBase({
    id,
    name: label,
    description: null,
    folder_path: folderPath,
    created_at: Date.now(),
    last_indexed_at: null,
  });
  kbIds.push(id);
  for (const folder of folders) await db.shareKnowledgeBase(id, folder);
  return { id, folderPath };
}

const save = (kbId: string, writer: string) =>
  save_to_knowledge.handler(
    { kb_id: kbId, filename: 'note.md', content: 'content' },
    {} as any,
    { group_folder: writer },
  );
const update = (kbId: string, writer: string) =>
  update_knowledge_document.handler(
    { kb_id: kbId, filename: 'note.md', content: 'changed' },
    {} as any,
    { group_folder: writer },
  );

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
});
afterEach(() => mock.restore());
afterAll(async () => {
  for (const id of kbIds) await db.deleteKnowledgeBase(id);
  for (const jid of jids) await unregisterGroup(jid);
  await drizzleDbRef.current.delete(users).where(inArray(users.id, userIds));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('knowledge write privacy gate', () => {
  test('strict writer cannot save or update in a KB shared with a non-strict project', async () => {
    const strict = await project('strict-a', 'strict');
    const open = await project('open-a', 'off');
    const kb = await sharedKb('refused', [strict, open]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    fs.writeFileSync(path.join(kb.folderPath, 'note.md'), 'existing');

    await expect(save(kb.id, strict)).rejects.toBeInstanceOf(PrivacyRefusal);
    await expect(update(kb.id, strict)).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(
      fs.readdirSync(kb.folderPath).filter((f) => f !== 'note.md'),
    ).toEqual([]);
    expect(fs.readFileSync(path.join(kb.folderPath, 'note.md'), 'utf8')).toBe(
      'existing',
    );
  });

  test('strict writer succeeds when only strict projects share the KB', async () => {
    const strict = await project('strict-b', 'strict');
    const otherStrict = await project('strict-c', 'strict');
    const own = await sharedKb('strict-own', [strict]);
    const shared = await sharedKb('strict-shared', [strict, otherStrict]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);

    await save(own.id, strict);
    await save(shared.id, strict);
    await update(shared.id, strict);
    expect(
      fs.readFileSync(path.join(shared.folderPath, 'note.md'), 'utf8'),
    ).toBe('changed');
  });

  test.each(['off', 'local_memory'] as const)(
    '%s writer is unaffected when sharing with an off project',
    async (mode) => {
      const writer = await project(`writer-${mode}`, mode);
      const open = await project(`open-${mode}`, 'off');
      const kb = await sharedKb(`unaffected-${mode}`, [writer, open]);
      spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);

      await save(kb.id, writer);
      await update(kb.id, writer);
      expect(fs.readFileSync(path.join(kb.folderPath, 'note.md'), 'utf8')).toBe(
        'changed',
      );
    },
  );
});

describe('knowledge target_project privacy gate', () => {
  const ctx = (
    caller: string,
    target: string,
    permission: 'memories:read' | 'memories:write',
  ) => ({ group_folder: caller, permissions: { [target]: [permission] } });
  const targetArgs = (kbId: string, target: string) => ({
    kb_id: kbId,
    target_project: target,
  });

  test('off reader cannot read a strict source through target_project; strict reader can', async () => {
    const source = await project('tp-source', 'strict');
    const open = await project('tp-open', 'off');
    const strictReader = await project('tp-strict-reader', 'strict');
    const kb = await sharedKb('tp-read', [source]);
    fs.writeFileSync(path.join(kb.folderPath, 'note.md'), 'secret');
    spyOn(KnowledgeService, 'searchKnowledge').mockResolvedValue([]);

    const calls = (reader: string) => [
      () =>
        read_knowledge_document.handler(
          { ...targetArgs(kb.id, source), filename: 'note.md' },
          {} as any,
          ctx(reader, source, 'memories:read'),
        ),
      () =>
        list_knowledge_documents.handler(
          targetArgs(kb.id, source),
          {} as any,
          ctx(reader, source, 'memories:read'),
        ),
      () =>
        search_knowledge.handler(
          { query: 'secret', limit: 5, verify: false, target_project: source },
          {} as any,
          ctx(reader, source, 'memories:read'),
        ),
    ];
    for (const call of calls(open))
      await expect(call()).rejects.toBeInstanceOf(PrivacyRefusal);
    for (const call of calls(strictReader)) await call();
  });

  test('strict caller cannot write through target_project into a KB shared with a non-strict project', async () => {
    const strict = await project('tp-strict-writer', 'strict');
    const open = await project('tp-open-target', 'off');
    const kb = await sharedKb('tp-write', [strict, open]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    fs.writeFileSync(path.join(kb.folderPath, 'note.md'), 'existing');
    const context = ctx(strict, open, 'memories:write');

    await expect(
      save_to_knowledge.handler(
        {
          kb_id: kb.id,
          filename: 'new.md',
          content: 'content',
          target_project: open,
        },
        {} as any,
        context,
      ),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    await expect(
      update_knowledge_document.handler(
        {
          kb_id: kb.id,
          filename: 'note.md',
          content: 'changed',
          target_project: open,
        },
        {} as any,
        context,
      ),
    ).rejects.toBeInstanceOf(PrivacyRefusal);
    expect(fs.readdirSync(kb.folderPath)).toEqual(['note.md']);
  });

  test('off caller can still save through target_project into an off target', async () => {
    const caller = await project('tp-off-caller', 'off');
    const target = await project('tp-off-target', 'off');
    const kb = await sharedKb('tp-off-write', [target]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);

    await save_to_knowledge.handler(
      {
        kb_id: kb.id,
        filename: 'new.md',
        content: 'content',
        target_project: target,
      },
      {} as any,
      ctx(caller, target, 'memories:write'),
    );
    expect(fs.existsSync(path.join(kb.folderPath, 'new.md'))).toBe(true);
  });
});
