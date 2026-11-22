import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('UI sandbox memory-review fixture', () => {
  test('seeds one reviewable, non-stale batch and stays idempotent', () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'carapa-memory-review-fixture-'),
    );
    try {
      // GROUPS_DIR is fixed at config import time, so run in a child process
      // with its own data root.
      const script = `
        const state = await import('./src/state-manager.ts');
        const review = await import('./src/modules/memory/history-review.ts');
        const fixture = await import('./scripts/ui-sandbox/memory-review-fixture.ts');
        await state.loadState();
        await state.registerGroup('ui-running@test', {
          name: 'ui-running', folder: 'ui-running', trigger: '!',
          added_at: new Date().toISOString(), settings: {},
        });
        const first = await fixture.seedMemoryReviewFixtures('ui-running');
        const second = await fixture.seedMemoryReviewFixtures('ui-running');
        const batches = await review.listHistoryReviewBatches();
        const detail = await review.getHistoryReviewBatch(first.batchId);
        process.stdout.write('FIXTURE_RESULT=' + JSON.stringify({
          sameId: first.batchId === second.batchId,
          batches,
          project: detail.projects[0],
        }));
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CARAPA_DATA_DIR: dataDir, NODE_ENV: 'test' },
      });
      const result = JSON.parse(output.split('FIXTURE_RESULT=').at(-1) || '{}');
      expect(result.sameId).toBe(true);
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0]).toMatchObject({ projects: 1, errors: 0 });
      expect(result.batches[0].pending_operations).toBeGreaterThanOrEqual(2);
      expect(result.project.review_enabled).toBe(true);
      expect(result.project.review_stale).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
