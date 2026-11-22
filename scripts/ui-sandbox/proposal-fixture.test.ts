import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UI sandbox proposal fixture', () => {
  test('seeds a pending rule and skill proposal conversation once', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-proposal-fixture-'),
    );
    try {
      // GROUPS_DIR is fixed at config import time, so run in a child process
      // with its own data root.
      const script = `
        const state = await import('./src/state-manager.ts');
        const chats = await import('./src/modules/chat/db-chats.ts');
        const fixture = await import('./scripts/ui-sandbox/proposal-fixture.ts');
        const { drizzleDbRef } = await import('./src/db/drizzle-client.ts');
        const { proposals } = await import('./src/db/schema.ts');
        await (await import('./src/db.ts')).initDatabase();
        await state.loadState();
        await state.registerGroup('ui-chat@test', {
          name: 'ui-chat', folder: 'ui-chat', trigger: '!',
          added_at: new Date().toISOString(), settings: {},
        });
        const first = await fixture.seedProposalFixtures('ui-chat');
        const second = await fixture.seedProposalFixtures('ui-chat');
        const rows = await drizzleDbRef.current.select().from(proposals);
        const messages = await chats.getChatMessages(
          'ui-chat', 100, first.conversation_id,
        );
        process.stdout.write('FIXTURE_RESULT=' + JSON.stringify({
          first, second, rows, messages,
        }));
        // PGlite aborts the process on exit unless it is closed first.
        await Bun.sleep(50);
        await drizzleDbRef.current.$client.close();
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          CARAPA_DATA_DIR: dataDir,
          DATABASE_URL: path.join(dataDir, 'pglite'),
          NODE_ENV: 'test',
        },
      });
      const result = JSON.parse(output.split('FIXTURE_RESULT=').at(-1) || '{}');
      expect(result.second).toEqual(result.first);
      expect(result.first.proposal_ids).toHaveLength(2);
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((r: any) => r.status)).toEqual([
        'pending',
        'pending',
      ]);
      expect(result.rows.map((r: any) => r.kind).sort()).toEqual([
        'rule',
        'skill',
      ]);
      expect(new Set(result.rows.map((r: any) => r.conversation_id))).toEqual(
        new Set([result.first.conversation_id]),
      );
      const assistant = result.messages.filter(
        (m: any) => m.role === 'assistant',
      );
      expect(assistant).toHaveLength(1);
      expect(assistant[0].content.match(/carapaproposal/g)).toHaveLength(2);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
