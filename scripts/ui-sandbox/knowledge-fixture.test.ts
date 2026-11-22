import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UI sandbox knowledge fixture', () => {
  test('seeds one shared knowledge base with two documents and stays idempotent', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-knowledge-fixture-'),
    );
    try {
      // KNOWLEDGE_DIR is fixed at config import time, so run in a child
      // process with its own data root.
      const script = `
        const { initDatabase } = await import('./src/db.ts');
        const state = await import('./src/state-manager.ts');
        const kb = await import('./src/modules/knowledge/db-kb.ts');
        const { KnowledgeService } = await import('./src/modules/knowledge/knowledge-service.ts');
        const fixture = await import('./scripts/ui-sandbox/knowledge-fixture.ts');
        await initDatabase(':memory:');
        await state.loadState();
        for (const folder of ['ui-chat', 'ui-running']) {
          await state.registerGroup(folder + '@test', {
            name: folder, folder, trigger: '!',
            added_at: new Date().toISOString(), settings: {},
          });
        }
        const owner = await kb.createUser('fixture-admin', 'secret', 'admin');
        const projects = ['ui-chat', 'ui-running'];
        const first = await fixture.seedKnowledgeFixtures(owner.id, projects);
        await fixture.seedKnowledgeFixtures(owner.id, projects);
        const bases = await kb.getAllKnowledgeBases();
        const files = (await KnowledgeService.listFiles(first.kbId)).map((f) => f.name).sort();
        const shared = {};
        for (const p of projects) shared[p] = (await kb.getSharedKnowledgeBases(p)).map((b) => b.id);
        process.stdout.write('FIXTURE_RESULT=' + JSON.stringify({
          kbId: first.kbId,
          bases: bases.map((b) => ({ id: b.id, name: b.name })),
          files,
          shared,
          members: await kb.getKBsForUser(owner.id),
        }));
        process.exit(0);
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CARAPA_DATA_DIR: dataDir, NODE_ENV: 'test' },
      });
      const result = JSON.parse(output.split('FIXTURE_RESULT=').at(-1) || '{}');
      expect(result.bases).toEqual([
        { id: result.kbId, name: 'UI Sandbox KB' },
      ]);
      expect(result.files).toEqual(['docs/guide.md', 'welcome.md']);
      expect(result.shared).toEqual({
        'ui-chat': [result.kbId],
        'ui-running': [result.kbId],
      });
      expect(result.members).toEqual([result.kbId]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
