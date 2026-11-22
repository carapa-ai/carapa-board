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

const prefix = `kb-oauth-${process.pid}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-oauth-'));
const jids: string[] = [];
const userIds: string[] = [];
const kbIds: string[] = [];

async function user(label: string) {
  const id = `${prefix}-user-${label}`;
  userIds.push(id);
  await drizzleDbRef.current.insert(users).values({
    id,
    username: id,
    password_hash: 'unused',
    created_at: new Date().toISOString(),
  });
  return id;
}

async function project(name: string) {
  const folder = `${prefix}-${name}`;
  const jid = `${folder}@web`;
  jids.push(jid);
  await registerGroup(jid, {
    jid,
    name,
    folder,
    trigger: `@${name}`,
    added_at: new Date().toISOString(),
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
  fs.writeFileSync(path.join(folderPath, 'note.md'), 'existing');
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
  return { id, name: label, folderPath };
}

const oauth = (
  group_folder: string,
  userId: string,
  permissions: Record<string, string[]>,
  isAdmin = false,
) => ({
  group_folder,
  permissions,
  kind: 'oauth',
  oauth_access: 'write',
  oauth_user_id: userId,
  oauth_user_is_admin: isAdmin,
});

const call = (tool: any, args: any, context: any) =>
  tool.handler(args, {} as any, context);

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

describe('knowledge tools over MCP OAuth', () => {
  test('target_project reaches a child project only with a matching permission', async () => {
    const parent = await project('parent');
    const child = await project('child');
    const readOnlyChild = await project('ro-child');
    const u = await user('member');
    const kb = await sharedKb('child-kb', [child, readOnlyChild]);
    await db.upsertKbMember(u, kb.id, 'owner');
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    const ctx = oauth(parent, u, {
      [parent]: ['memories:*'],
      [child]: ['memories:*'],
      [readOnlyChild]: ['memories:read'],
    });

    const listed = JSON.parse(
      await call(
        list_knowledge_documents,
        { kb_id: kb.id, target_project: child },
        ctx,
      ),
    );
    expect(listed.kbId).toBe(kb.id);
    // Not shared with the parent itself.
    await expect(
      call(list_knowledge_documents, { kb_id: kb.id }, ctx),
    ).rejects.toThrow('not found or not shared');
    await expect(
      call(
        list_knowledge_documents,
        { kb_id: kb.id, target_project: 'unlisted' },
        ctx,
      ),
    ).rejects.toThrow(
      'Unauthorized: no knowledge access for project "unlisted"',
    );

    // Read works with memories:read, writing does not.
    await call(
      read_knowledge_document,
      { kb_id: kb.id, filename: 'note.md', target_project: readOnlyChild },
      ctx,
    );
    await expect(
      call(
        save_to_knowledge,
        { kb_id: kb.id, content: 'x', target_project: readOnlyChild },
        ctx,
      ),
    ).rejects.toThrow(
      `Unauthorized: no knowledge access for project "${readOnlyChild}"`,
    );
    await call(
      save_to_knowledge,
      { kb_id: kb.id, content: 'x', filename: 'new.md', target_project: child },
      ctx,
    );
    expect(fs.existsSync(path.join(kb.folderPath, 'new.md'))).toBe(true);
  });

  test('a read-only home project cannot be written through a grant that is writable elsewhere', async () => {
    const home = await project('ro-home');
    const writable = await project('rw-other');
    const u = await user('mixed');
    const kb = await sharedKb('home-kb', [home, writable]);
    await db.upsertKbMember(u, kb.id, 'owner');
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    const ctx = oauth(home, u, {
      [home]: ['memories:read'],
      [writable]: ['memories:*'],
    });

    await call(
      read_knowledge_document,
      { kb_id: kb.id, filename: 'note.md' },
      ctx,
    );
    const denied = `Unauthorized: no knowledge access for project "${home}"`;
    await expect(
      call(
        save_to_knowledge,
        { kb_id: kb.id, content: 'x', filename: 'h.md' },
        ctx,
      ),
    ).rejects.toThrow(denied);
    await expect(
      call(
        update_knowledge_document,
        { kb_id: kb.id, filename: 'note.md', content: 'changed' },
        ctx,
      ),
    ).rejects.toThrow(denied);
    expect(fs.existsSync(path.join(kb.folderPath, 'h.md'))).toBe(false);
    expect(fs.readFileSync(path.join(kb.folderPath, 'note.md'), 'utf8')).toBe(
      'existing',
    );
    // The writable project still works when named explicitly.
    await call(
      save_to_knowledge,
      {
        kb_id: kb.id,
        content: 'x',
        filename: 'w.md',
        target_project: writable,
      },
      ctx,
    );
    expect(fs.existsSync(path.join(kb.folderPath, 'w.md'))).toBe(true);
  });

  test('a KB viewer reads and searches but cannot write', async () => {
    const folder = await project('viewer-project');
    const u = await user('viewer');
    const kb = await sharedKb('viewer-kb', [folder]);
    await db.upsertKbMember(u, kb.id, 'viewer');
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    const listFiles = spyOn(KnowledgeService, 'listFiles').mockResolvedValue(
      [],
    );
    const ctx = oauth(folder, u, { [folder]: ['memories:*'] });

    await call(
      read_knowledge_document,
      { kb_id: kb.id, filename: 'note.md' },
      ctx,
    );
    await call(search_knowledge, { query: 'q', tags: ['t'] }, ctx);
    expect(listFiles).toHaveBeenCalledWith(kb.id);

    const readOnly = `Unauthorized: knowledge base "${kb.name}" is read-only for you`;
    await expect(
      call(save_to_knowledge, { kb_id: kb.id, content: 'x' }, ctx),
    ).rejects.toThrow(readOnly);
    await expect(
      call(
        update_knowledge_document,
        { kb_id: kb.id, filename: 'note.md', content: 'changed' },
        ctx,
      ),
    ).rejects.toThrow(readOnly);
    expect(fs.readFileSync(path.join(kb.folderPath, 'note.md'), 'utf8')).toBe(
      'existing',
    );
  });

  test('a non-member does not see the KB in list, search or read; admins do', async () => {
    const folder = await project('hidden-project');
    const outsider = await user('outsider');
    const admin = await user('admin');
    const kb = await sharedKb('hidden-kb', [folder]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    const listFiles = spyOn(KnowledgeService, 'listFiles').mockResolvedValue(
      [],
    );
    const perms = { [folder]: ['memories:*'] };

    const outsiderCtx = oauth(folder, outsider, perms);
    await expect(
      call(list_knowledge_documents, { kb_id: kb.id }, outsiderCtx),
    ).rejects.toThrow('not found or not shared');
    await expect(
      call(
        read_knowledge_document,
        { kb_id: kb.id, filename: 'note.md' },
        outsiderCtx,
      ),
    ).rejects.toThrow('not found or not shared');
    await call(search_knowledge, { query: 'q', tags: ['t'] }, outsiderCtx);
    expect(listFiles).not.toHaveBeenCalled();
    await expect(
      call(save_to_knowledge, { kb_id: kb.id, content: 'x' }, outsiderCtx),
    ).rejects.toThrow('No knowledge bases are shared with this project');

    const adminCtx = oauth(folder, admin, perms, true);
    await call(list_knowledge_documents, { kb_id: kb.id }, adminCtx);
    await call(search_knowledge, { query: 'q', tags: ['t'] }, adminCtx);
    expect(listFiles).toHaveBeenCalledWith(kb.id);
    await call(
      save_to_knowledge,
      { kb_id: kb.id, content: 'x', filename: 'admin.md' },
      adminCtx,
    );
    expect(fs.existsSync(path.join(kb.folderPath, 'admin.md'))).toBe(true);
  });

  test('non-OAuth callers keep project-only scope without KB membership', async () => {
    const folder = await project('agent-project');
    const kb = await sharedKb('agent-kb', [folder]);
    spyOn(KnowledgeService, 'indexFile').mockResolvedValue(undefined);
    const ctx = { group_folder: folder, kind: 'agent' };

    await call(list_knowledge_documents, { kb_id: kb.id }, ctx);
    await call(
      save_to_knowledge,
      { kb_id: kb.id, content: 'x', filename: 'agent.md' },
      ctx,
    );
    expect(fs.existsSync(path.join(kb.folderPath, 'agent.md'))).toBe(true);
  });
});
