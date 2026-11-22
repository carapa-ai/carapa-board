import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('durable group registration', () => {
  test('strict mode rejects missing or failed persistence and rolls back memory', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-durable-registration-'),
    );
    try {
      const script = `
        const state = await import('./src/state-manager.ts');
        const db = await import('./src/db/drizzle-client.ts');
        await state.loadState();
        const group = (folder) => ({ name: folder, folder, trigger: '@Capa', added_at: new Date().toISOString(), settings: {} });
        let missingRejected = false;
        try { await state.registerGroup('missing-db', group('missing-db'), { requirePersistence: true }); }
        catch { missingRejected = true; }
        db.drizzleDbRef.current = {
          insert() { return { values() { return { async onConflictDoUpdate() { throw new Error('forced persistence failure'); } }; } }; },
        };
        let failureRejected = false;
        try { await state.registerGroup('failed-db', group('failed-db'), { requirePersistence: true }); }
        catch { failureRejected = true; }
        process.stdout.write('DURABLE_RESULT=' + JSON.stringify({
          missingRejected,
          missingRolledBack: !state.registeredGroups['missing-db'],
          failureRejected,
          failureRolledBack: !state.registeredGroups['failed-db'],
        }));
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CARAPA_DATA_DIR: dataDir },
      });
      const result = JSON.parse(output.split('DURABLE_RESULT=').at(-1) || '{}');
      expect(result).toEqual({
        missingRejected: true,
        missingRolledBack: true,
        failureRejected: true,
        failureRolledBack: true,
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
