import fs from 'node:fs';
import path from 'node:path';

import { KNOWLEDGE_DIR } from '../../src/config.js';
import {
  createKnowledgeBase,
  getKnowledgeBase,
  shareKnowledgeBase,
  updateKnowledgeDocumentMetadata,
  upsertKbMember,
} from '../../src/modules/knowledge/db-kb.js';

export const KNOWLEDGE_FIXTURE_KB_ID = 'ui-sandbox-kb';
export const KNOWLEDGE_FIXTURE_KB_NAME = 'UI Sandbox KB';

const FIXTURE_ADDED_AT = new Date('2026-07-20T09:00:00.000Z');

const DOCUMENTS = [
  {
    path: 'welcome.md',
    title: 'Welcome',
    description: 'Fake sandbox document with a source link.',
    sourceUrl: 'https://example.com/sandbox/welcome',
    tags: ['sandbox'],
    content:
      '# Welcome\n\nThis is a fake sandbox document. It contains no real data.\n',
  },
  {
    path: 'docs/guide.md',
    title: 'Sandbox guide',
    tags: ['sandbox', 'guide'],
    content:
      '# Sandbox guide\n\nA nested fake document used to walk the Knowledge Hub folders.\n',
  },
] as const;

/**
 * Seeds one knowledge base with two unindexed markdown documents, owned by the
 * given user and shared with the given projects. Files are written directly
 * (not via `KnowledgeService.addFile`) so no background embedding job runs.
 * Reruns reuse the fixed ids and overwrite the same rows and files.
 */
export async function seedKnowledgeFixtures(
  ownerUserId: string,
  projectIds: readonly string[],
): Promise<{ kbId: string }> {
  const folderPath = path.join(KNOWLEDGE_DIR, KNOWLEDGE_FIXTURE_KB_ID);
  if (!(await getKnowledgeBase(KNOWLEDGE_FIXTURE_KB_ID))) {
    await createKnowledgeBase({
      id: KNOWLEDGE_FIXTURE_KB_ID,
      name: KNOWLEDGE_FIXTURE_KB_NAME,
      description: 'Fake documents for walking the Knowledge Hub.',
      folder_path: folderPath,
      last_indexed_at: null,
      created_at: FIXTURE_ADDED_AT.getTime(),
    });
  }
  for (const doc of DOCUMENTS) {
    const filePath = path.join(folderPath, doc.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, doc.content);
    await updateKnowledgeDocumentMetadata(KNOWLEDGE_FIXTURE_KB_ID, doc.path, {
      title: doc.title,
      ...('sourceUrl' in doc
        ? { description: doc.description, sourceUrl: doc.sourceUrl }
        : {}),
      tags: [...doc.tags],
      addedAt: FIXTURE_ADDED_AT,
    });
  }
  await upsertKbMember(ownerUserId, KNOWLEDGE_FIXTURE_KB_ID, 'owner');
  for (const projectId of projectIds) {
    await shareKnowledgeBase(KNOWLEDGE_FIXTURE_KB_ID, projectId);
  }
  return { kbId: KNOWLEDGE_FIXTURE_KB_ID };
}
