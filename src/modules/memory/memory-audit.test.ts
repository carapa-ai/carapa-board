import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import * as schema from '../../db/schema.js';
import {
  approvePendingMemoryAuditItems,
  dismissMemoryAuditItemsForDeletedMemories,
  getActiveMemoryAudit,
  getMemoryAudit,
  getMemoryAuditReport,
  markSkippedMemoryAuditItemDeleted,
  refreshMemoryAuditProgress,
  skipMemoryAuditBatch,
} from './db-memory-audits.js';
import {
  beginMemoryIndexCollection,
  finishMemoryIndexCollection,
  getMemoryIndexAuditSummary,
  listMemoryIndexCandidates,
  recordMemoryIndexReconciliation,
  resolveMemoryIndexCollector,
  storeMemoryIndexCandidate,
} from './db-memory-index.js';
import {
  memoryStructuralFingerprint,
  summarizeMemoryAuditReview,
  type MemoryAuditItem,
} from './memory-audit-types.js';
import { getMemory } from '../../db.js';
import {
  applyProjectMemoryAudit,
  normalizeReflection,
  recoverMemoryAudits,
  reviewMemoryAuditItem,
} from './memory-audit.js';
import type { Memory } from './types.js';

async function applyMigration(pg: PGlite, name: string): Promise<void> {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'drizzle', name),
    'utf8',
  );
  for (const statement of source.split('--> statement-breakpoint')) {
    if (statement.trim()) await pg.exec(statement);
  }
}

function exampleMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem-audit-1',
    group_folder: 'project-audit',
    content: 'Use PostgreSQL for durable state.',
    memory_type: 'decision',
    importance: 0.8,
    source: 'user',
    sourceRef: 'conversation:c1#m1',
    tags: ['architecture'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: '2026-01-01T00:00:00.000Z',
    access_count: 0,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    ...overrides,
  };
}

describe('memory audit fingerprint', () => {
  test('ignores access metadata and maintenance-only importance decay', () => {
    const first = exampleMemory();
    const maintained = exampleMemory({
      importance: 0.51,
      access_count: 99,
      last_accessed_at: '2026-07-31T00:00:00.000Z',
      updated_at: '2026-07-31T00:00:00.000Z',
    });
    expect(memoryStructuralFingerprint(first)).toBe(
      memoryStructuralFingerprint(maintained),
    );
    expect(
      memoryStructuralFingerprint(exampleMemory({ content: 'Use SQLite.' })),
    ).not.toBe(memoryStructuralFingerprint(first));
  });
});

describe('partial memory audit review', () => {
  const proposal = (
    overrides: Partial<MemoryAuditItem> = {},
  ): MemoryAuditItem => ({
    id: 'mai-partial',
    audit_id: 'ma-partial',
    memory_id: 'mem-partial',
    memory_fingerprint: 'fp',
    processing_state: 'complete',
    disposition: 'erase',
    review_decision: 'pending',
    revision: 0,
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
    stale: false,
    ...overrides,
  });

  test('allows reviewed items to apply while the audit is still running', () => {
    const review = summarizeMemoryAuditReview('running', [
      proposal({ id: 'approved', review_decision: 'approved' }),
      proposal({ id: 'later', memory_id: 'later' }),
    ]);
    expect(review.apply_enabled).toBe(true);
    expect(review.counts).toEqual({
      pending: 1,
      approved: 1,
      rejected: 0,
      applied: 0,
      applicable: 1,
      skipped: 0,
      delete_memory: 0,
      delete_both: 0,
      dismissed: 0,
    });
  });

  test('counts reviewed move proposals as applicable work', () => {
    const review = summarizeMemoryAuditReview('ready', [
      proposal({
        disposition: 'move',
        target_project_id: 'related-project',
        review_decision: 'approved',
      }),
    ]);
    expect(review.counts.approved).toBe(1);
    expect(review.counts.applicable).toBe(1);
    expect(review.apply_enabled).toBe(true);
  });

  test('counts a failed evidence batch as skipped instead of reviewable', () => {
    const review = summarizeMemoryAuditReview('running', [
      proposal({
        processing_state: 'error',
        disposition: 'keep',
        confidence: 0,
        reason: 'Evidence file is unavailable',
      }),
    ]);
    expect(review.counts).toEqual({
      pending: 0,
      approved: 0,
      rejected: 0,
      applied: 0,
      applicable: 0,
      skipped: 1,
      delete_memory: 0,
      delete_both: 0,
      dismissed: 0,
    });
    expect(review.apply_enabled).toBe(false);
    expect(
      summarizeMemoryAuditReview('applied', [
        proposal({
          processing_state: 'error',
          disposition: 'keep',
          review_decision: 'delete_memory',
          applied_at: '2026-07-31T02:00:00.000Z',
        }),
      ]).counts.skipped,
    ).toBe(0);
  });

  test('ignores already-applied items and blocks only a selected stale item', () => {
    const applied = proposal({
      review_decision: 'approved',
      applied_at: '2026-07-31T01:00:00.000Z',
      stale: true,
    });
    expect(summarizeMemoryAuditReview('paused', [applied])).toEqual({
      counts: {
        pending: 0,
        approved: 0,
        rejected: 0,
        applied: 1,
        applicable: 0,
        skipped: 0,
        delete_memory: 0,
        delete_both: 0,
        dismissed: 0,
      },
      apply_enabled: false,
    });
    expect(
      summarizeMemoryAuditReview('paused', [
        proposal({ review_decision: 'approved', stale: true }),
      ]).apply_enabled,
    ).toBe(false);
  });

  test('allows stale proposals to be dismissed and live merges to delete both', () => {
    const review = summarizeMemoryAuditReview('ready', [
      proposal({
        id: 'stale',
        stale: true,
        review_decision: 'dismissed',
      }),
      proposal({
        id: 'merge',
        memory_id: 'merge-source',
        disposition: 'merge',
        review_decision: 'delete_both',
      }),
    ]);
    expect(review.counts).toMatchObject({
      applicable: 2,
      delete_both: 1,
      dismissed: 1,
    });
    expect(review.apply_enabled).toBe(true);
  });
});

describe('memory audit migration', () => {
  test('enforces one active audit and cascades reconstructive evidence on erase', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    const previousDb = drizzleDbRef.current;
    try {
      await applyMigration(pg, '0000_baseline.sql');
      const now = '2026-07-31T00:00:00.000Z';
      await pg.query(
        `INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('u-audit','audit-admin','x','admin',$1,0)`,
        [now],
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-audit','j','Audit','project-audit','',$1,0,'u-audit')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-audit-1','project-audit','Durable fact','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      const auditValues = `('ma-1','project-audit','u-audit','codex:test','v1','ready',1,1,1,1,0,'baseline',$1,$1)`;
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ${auditValues}`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,review_decision,revision,applied_at,created_at,updated_at) VALUES ('mai-1','ma-1','mem-audit-1','fp','complete','erase','approved',0,$1,$1,$1), ('mai-move','ma-1','mem-moved','fp-move','complete','move','approved',0,$1,$1,$1), ('mai-delete-memory','ma-1','mem-rewrite','fp-rewrite','complete','rewrite','delete_memory',0,$1,$1,$1), ('mai-delete-both','ma-1','mem-merge-source','fp-merge','complete','merge','delete_both',0,$1,$1,$1), ('mai-rejected','ma-1','mem-rejected','fp-rejected','complete','create','rejected',0,$1,$1,$1)`,
        [now],
      );
      drizzleDbRef.current = pgliteDrizzle(pg, { schema });
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,review_decision,revision,created_at,updated_at) VALUES ('mai-bulk-pending','ma-1','mem-bulk-pending','fp-bulk','complete','rewrite','pending',2,$1,$1), ('mai-bulk-rejected','ma-1','mem-bulk-rejected','fp-bulk-rejected','complete','rewrite','rejected',3,$1,$1)`,
        [now],
      );
      expect(
        await approvePendingMemoryAuditItems({
          auditId: 'ma-1',
          itemIds: ['mai-bulk-pending', 'mai-bulk-rejected'],
          reviewer: 'audit-admin',
        }),
      ).toBe(1);
      expect(
        (
          await pg.query(
            `SELECT id,review_decision,reviewed_by,revision FROM memory_audit_items WHERE id IN ('mai-bulk-pending','mai-bulk-rejected') ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        {
          id: 'mai-bulk-pending',
          review_decision: 'approved',
          reviewed_by: 'audit-admin',
          revision: 3,
        },
        {
          id: 'mai-bulk-rejected',
          review_decision: 'rejected',
          reviewed_by: null,
          revision: 3,
        },
      ]);
      await pg.query(
        `DELETE FROM memory_audit_items WHERE id IN ('mai-bulk-pending','mai-bulk-rejected')`,
      );
      await pg.query(
        `INSERT INTO memory_evidence_certificates (id,memory_id,project_id,memory_fingerprint,verdict,value_justification,evidence_type,reflector_version,origin,created_at,updated_at) VALUES ('mec-1','mem-audit-1','project-audit','fp','erase','garbage','code','v1','automatic',$1,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_evidence_files (id,certificate_id,repository_root,path,file_sha256,excerpt_sha256,excerpt,verified_at) VALUES ('mef-1','mec-1','/workspace/repo','src/a.ts','f','e','proof',$1)`,
        [now],
      );

      await expect(
        pg.query(
          `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,baseline_fingerprint,created_at,updated_at) VALUES ('ma-2','project-audit','u-audit','codex:test','v1','running','b',$1,$1)`,
          [now],
        ),
      ).rejects.toThrow();
      await pg.query(`DELETE FROM memories WHERE id='mem-audit-1'`);
      expect(
        (await pg.query(`SELECT id FROM memory_evidence_certificates`)).rows,
      ).toHaveLength(0);
      expect(
        (await pg.query(`SELECT id FROM memory_evidence_files`)).rows,
      ).toHaveLength(0);
      expect(
        (
          await pg.query(
            `SELECT memory_id FROM memory_audit_items WHERE id='mai-1'`,
          )
        ).rows[0],
      ).toEqual({ memory_id: 'mem-audit-1' });
      expect(
        (await pg.query(`SELECT mode FROM memory_audits WHERE id='ma-1'`))
          .rows[0],
      ).toEqual({ mode: 'cleanup' });
      expect(
        (
          await pg.query(
            `SELECT target_project_id FROM memory_audit_items WHERE id='mai-1'`,
          )
        ).rows[0],
      ).toEqual({ target_project_id: null });
      await pg.query(
        `UPDATE memory_audits SET retry_count=2,error='prior batch failure' WHERE id='ma-1'`,
      );
      await refreshMemoryAuditProgress('ma-1', { successfulBatch: true });
      expect(await getMemoryAudit('ma-1')).toMatchObject({
        cursor: 5,
        retry_count: 0,
        error: null,
      });
      const report = await getMemoryAuditReport('project-audit');
      expect(report.totals).toEqual({
        erased: 4,
        merged: 0,
        created: 0,
        moved: 1,
      });
      expect(report.last_applied_at).toBe(now);
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-empty','j-empty','Empty','project-empty','',$1,0,'u-audit')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ('ma-empty','project-empty','u-audit','codex:test','v1','ready',6,6,0,6,2,'empty-baseline',$1,$1)`,
        [now],
      );
      expect(await getActiveMemoryAudit('project-empty')).toBeNull();
      expect(await getMemoryAudit('ma-empty')).toMatchObject({
        status: 'applied',
        retry_count: 0,
      });
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,merge_target_id,review_decision,revision,created_at,updated_at) VALUES ('mai-deleted','ma-1','mem-gone','fp-deleted','complete','rewrite',null,'pending',0,$1,$1), ('mai-dependent','ma-1','mem-dependent','fp-dependent','complete','merge','mem-gone','approved',0,$1,$1)`,
        [now],
      );
      expect(
        await dismissMemoryAuditItemsForDeletedMemories({
          auditId: 'ma-1',
          deletedMemoryIds: ['mem-gone'],
          exceptItemId: 'mai-delete-both',
          reviewer: 'audit-admin',
        }),
      ).toEqual(['mai-deleted']);
      expect(
        (
          await pg.query(
            `SELECT review_decision,reviewed_by,applied_at FROM memory_audit_items WHERE id='mai-deleted'`,
          )
        ).rows[0],
      ).toEqual({
        review_decision: 'dismissed',
        reviewed_by: 'audit-admin',
        applied_at: expect.any(String),
      });
      expect(
        (
          await pg.query(
            `SELECT review_decision,applied_at FROM memory_audit_items WHERE id='mai-dependent'`,
          )
        ).rows[0],
      ).toEqual({ review_decision: 'approved', applied_at: null });
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,review_decision,revision,created_at,updated_at) VALUES ('mai-skip','ma-1','mem-skip','fp-skip','pending','pending',0,$1,$1)`,
        [now],
      );
      await skipMemoryAuditBatch({
        itemIds: ['mai-skip'],
        reason: 'Skipped audit batch without certification: evidence missing',
      });
      await refreshMemoryAuditProgress('ma-1');
      expect(
        (
          await pg.query(
            `SELECT processing_state,disposition,confidence,reason FROM memory_audit_items WHERE id='mai-skip'`,
          )
        ).rows[0],
      ).toEqual({
        processing_state: 'error',
        disposition: 'keep',
        confidence: 0,
        reason: 'Skipped audit batch without certification: evidence missing',
      });
      expect(await getMemoryAudit('ma-1')).toMatchObject({ cursor: 8 });
      expect(
        await markSkippedMemoryAuditItemDeleted({
          auditId: 'ma-1',
          itemId: 'mai-skip',
          reviewer: 'audit-admin',
        }),
      ).toBe(true);
      expect(
        (
          await pg.query(
            `SELECT review_decision,reviewed_by,applied_at FROM memory_audit_items WHERE id='mai-skip'`,
          )
        ).rows[0],
      ).toEqual({
        review_decision: 'delete_memory',
        reviewed_by: 'audit-admin',
        applied_at: expect.any(String),
      });
      expect((await getMemoryAuditReport('project-audit')).totals.erased).toBe(
        5,
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-index','j-index','Index','project-index','',$1,0,'u-audit')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,mode,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at,started_at) VALUES ('ma-index','project-index','u-audit','llm:test','v2','index','running',1,0,0,0,0,'index-baseline',$1,$1,$1)`,
        [now],
      );
      const collectorToken = await beginMemoryIndexCollection('ma-index');
      expect(
        await resolveMemoryIndexCollector('project-index', collectorToken),
      ).toMatchObject({ auditId: 'ma-index' });
      await storeMemoryIndexCandidate({
        auditId: 'ma-index',
        candidate: {
          candidateId: 'routing',
          content: 'Routing starts in src/routes.ts.',
          memoryType: 'project',
          importance: 0.8,
          tags: ['routing'],
          retrievalValue: 'navigation',
          reason: 'Avoids a broad route search.',
          validFrom: now,
          evidence: [],
        },
        evidence: [
          {
            id: 'mae-routing',
            repository_root: '/workspace/project-index',
            path: '/workspace/project-index/src/routes.ts',
            excerpt: 'registerRoutes()',
            file_sha256: 'file-hash',
            excerpt_sha256: 'excerpt-hash',
            verified_at: now,
          },
        ],
      });
      await finishMemoryIndexCollection({
        auditId: 'ma-index',
        summary: 'Inspected routing.',
        inspectedAreas: ['src/routes.ts'],
      });
      await recordMemoryIndexReconciliation('ma-index', [
        {
          candidateId: 'routing',
          op: 'create',
          confidence: 1,
          reason: 'Missing durable navigation knowledge.',
          content: 'Routing starts in src/routes.ts.',
          memoryType: 'project',
          importance: 0.8,
          tags: ['routing'],
        },
      ]);
      expect(await listMemoryIndexCandidates('ma-index')).toHaveLength(1);
      expect(await getMemoryIndexAuditSummary('ma-index')).toMatchObject({
        discovered: 1,
        created: 1,
        finished_at: expect.any(String),
        inspected_areas: ['src/routes.ts'],
      });
    } finally {
      drizzleDbRef.current = previousDb;
      await pg.close();
    }
  });
});

describe('memory audit partial apply', () => {
  test('applies remaining items when one item fails to apply', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    const previousDb = drizzleDbRef.current;
    try {
      await applyMigration(pg, '0000_baseline.sql');
      const now = '2026-08-21T00:00:00.000Z';
      await pg.query(
        `INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('u-peritem','peritem-admin','x','admin',$1,0)`,
        [now],
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-peritem','j','PerItem','project-peritem','',$1,0,'u-peritem')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-ok','project-peritem','Durable fact one','decision',0.8,'user',$1,$1,$1,0,$1), ('mem-broken','project-peritem','Durable fact two','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      const fingerprintFor = (content: string) =>
        memoryStructuralFingerprint({
          content,
          memory_type: 'decision',
          tags: [],
          source: 'user',
          sourceRef: null,
          objective_id: null,
          valid_from: now,
          valid_to: null,
        } as unknown as Memory);
      const okFingerprint = fingerprintFor('Durable fact one');
      const brokenFingerprint = fingerprintFor('Durable fact two');
      // Only the healthy memory holds an active evidence certificate, so its
      // proposal can verify while the other one hits a 409 at apply time.
      await pg.query(
        `INSERT INTO memory_evidence_certificates (id,memory_id,project_id,memory_fingerprint,verdict,value_justification,evidence_type,reflector_version,origin,created_at,updated_at) VALUES ('cert-ok','mem-ok','project-peritem',$1,'keep','Durable fact one','code','v1','automatic',$2,$3)`,
        [okFingerprint, now, now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ('ma-peritem','project-peritem','u-peritem','codex:test','v1','ready',2,2,2,2,0,'baseline',$1,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,review_decision,revision,created_at,updated_at) VALUES ('mai-ok','ma-peritem','mem-ok',$1,'complete','rewrite','approved',0,$2,$3), ('mai-broken','ma-peritem','mem-broken',$4,'complete','rewrite','approved',0,$5,$6)`,
        [okFingerprint, now, now, brokenFingerprint, now, now],
      );
      drizzleDbRef.current = pgliteDrizzle(pg, { schema });

      const view = await applyProjectMemoryAudit('ma-peritem', 'u-peritem');
      const okItem = view.items.find((item) => item.id === 'mai-ok');
      const brokenItem = view.items.find((item) => item.id === 'mai-broken');
      expect(okItem?.applied_at).toBeTruthy();
      expect(okItem?.apply_error).toBeNull();
      expect(brokenItem?.applied_at).toBeNull();
      expect(brokenItem?.apply_error).toContain(
        'no active evidence certificate',
      );
      // The failed item must not abort the audit: it stays ready with a
      // summary of what could not be applied.
      expect(view.status).toBe('ready');
      expect(view.error).toContain('1 proposal(s) could not be applied');
      // The failing memory was not modified.
      expect(await getMemory('mem-broken')).toMatchObject({
        id: 'mem-broken',
        content: 'Durable fact two',
      });
    } finally {
      drizzleDbRef.current = previousDb;
      await pg.close();
    }
  });

  test('returns an audit interrupted while applying to ready and re-applies only unapplied items', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    const previousDb = drizzleDbRef.current;
    try {
      await applyMigration(pg, '0000_baseline.sql');
      const now = '2026-08-21T00:00:00.000Z';
      await pg.query(
        `INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('u-interrupt','interrupt-admin','x','admin',$1,0)`,
        [now],
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-interrupt','j','Interrupt','project-interrupt','',$1,0,'u-interrupt')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-done','project-interrupt','Applied fact','decision',0.8,'user',$1,$1,$1,0,$1), ('mem-todo','project-interrupt','Pending fact','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      const todoFingerprint = memoryStructuralFingerprint({
        content: 'Pending fact',
        memory_type: 'decision',
        tags: [],
        source: 'user',
        sourceRef: null,
        objective_id: null,
        valid_from: now,
        valid_to: null,
      } as unknown as Memory);
      await pg.query(
        `INSERT INTO memory_evidence_certificates (id,memory_id,project_id,memory_fingerprint,verdict,value_justification,evidence_type,reflector_version,origin,created_at,updated_at) VALUES ('cert-todo','mem-todo','project-interrupt',$1,'keep','Pending fact','code','v1','automatic',$2,$2)`,
        [todoFingerprint, now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ('ma-interrupt','project-interrupt','u-interrupt','codex:test','v1','applying',2,2,2,2,0,'baseline',$1,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,review_decision,applied_at,revision,created_at,updated_at) VALUES ('mai-done','ma-interrupt','mem-done','fp-done','complete','rewrite','approved',$1,0,$1,$1), ('mai-todo','ma-interrupt','mem-todo',$2,'complete','rewrite','approved',NULL,0,$1,$1)`,
        [now, todoFingerprint],
      );
      drizzleDbRef.current = pgliteDrizzle(pg, { schema });

      await recoverMemoryAudits();

      const active = await getActiveMemoryAudit('project-interrupt');
      expect(active?.status).toBe('ready');
      expect(active?.error).toContain('interrupted by a board restart');

      const view = await applyProjectMemoryAudit('ma-interrupt', 'u-interrupt');
      expect(view.status).toBe('applied');
      const doneItem = view.items.find((item) => item.id === 'mai-done');
      const todoItem = view.items.find((item) => item.id === 'mai-todo');
      expect(doneItem?.applied_at).toBe(now);
      expect(todoItem?.applied_at).toBeTruthy();
      expect(todoItem?.apply_error).toBeNull();
    } finally {
      drizzleDbRef.current = previousDb;
      await pg.close();
    }
  });
});

describe('memory audit stale resolution', () => {
  test('allows deleting or dismissing a stale rewrite proposal', async () => {
    const pg = new PGlite();
    await pg.waitReady;
    const previousDb = drizzleDbRef.current;
    try {
      await applyMigration(pg, '0000_baseline.sql');
      const now = '2026-07-31T00:00:00.000Z';
      await pg.query(
        `INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('u-stale','stale-admin','x','admin',$1,0)`,
        [now],
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-stale','j','Stale','project-stale','',$1,0,'u-stale')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-stale','project-stale','Original durable fact','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-stale-2','project-stale','Another durable fact','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ('ma-stale','project-stale','u-stale','codex:test','v1','ready',2,2,2,2,0,'baseline',$1,$1)`,
        [now],
      );
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,review_decision,revision,created_at,updated_at) VALUES ('mai-stale-delete','ma-stale','mem-stale','fp-original','complete','rewrite','pending',0,$1,$1), ('mai-stale-dismiss','ma-stale','mem-stale-2','fp-original-2','complete','erase','pending',0,$1,$1)`,
        [now],
      );
      // The memory changed after the audit ran, so both proposals are stale.
      await pg.query(
        `UPDATE memories SET content=CASE id WHEN 'mem-stale' THEN 'Edited after the audit' ELSE 'Also edited after the audit' END WHERE id IN ('mem-stale','mem-stale-2')`,
      );
      drizzleDbRef.current = pgliteDrizzle(pg, { schema });

      const view = await reviewMemoryAuditItem({
        auditId: 'ma-stale',
        itemId: 'mai-stale-delete',
        revision: 0,
        decision: 'delete_memory',
        reviewer: 'stale-admin',
      });
      const staleItem = view.items.find(
        (item) => item.id === 'mai-stale-delete',
      );
      expect(staleItem?.stale).toBe(true);
      expect(staleItem?.review_decision).toBe('delete_memory');
      expect(await getMemory('mem-stale')).toMatchObject({
        id: 'mem-stale',
        content: 'Edited after the audit',
      });

      await reviewMemoryAuditItem({
        auditId: 'ma-stale',
        itemId: 'mai-stale-dismiss',
        revision: 0,
        decision: 'dismissed',
        reviewer: 'stale-admin',
      });
      expect(
        (
          await pg.query(
            `SELECT id,review_decision FROM memory_audit_items WHERE audit_id='ma-stale' ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        { id: 'mai-stale-delete', review_decision: 'delete_memory' },
        { id: 'mai-stale-dismiss', review_decision: 'dismissed' },
      ]);
    } finally {
      drizzleDbRef.current = previousDb;
      await pg.close();
    }
  });
});

describe('memory audit reflector', () => {
  const rewrite = (overrides: Record<string, unknown> = {}) => ({
    memory_id: 'mem-ok',
    disposition: 'rewrite',
    confidence: 0.95,
    reason: 'Clearer wording',
    proposed_content: 'Durable fact one, clarified',
    ...overrides,
  });
  const allowed = new Set(['mem-ok']);

  test('memory audit reflector treats null proposed_importance as absent; approved rewrite keeps current importance', async () => {
    const normalized = normalizeReflection(
      rewrite({ proposed_memory_type: null, proposed_importance: null }),
      allowed,
    );
    expect(normalized.proposedImportance).toBeUndefined();

    const pg = new PGlite();
    await pg.waitReady;
    const previousDb = drizzleDbRef.current;
    try {
      await applyMigration(pg, '0000_baseline.sql');
      const now = '2026-08-21T00:00:00.000Z';
      await pg.query(
        `INSERT INTO users (id,username,password_hash,role,created_at,disabled) VALUES ('u-null','null-admin','x','admin',$1,0)`,
        [now],
      );
      await pg.query(
        `INSERT INTO projects (id,jid,name,folder,trigger,added_at,is_main,user_id) VALUES ('project-null','j','Null','project-null','',$1,0,'u-null')`,
        [now],
      );
      await pg.query(
        `INSERT INTO memories (id,group_folder,content,memory_type,importance,source,created_at,updated_at,last_accessed_at,access_count,valid_from) VALUES ('mem-ok','project-null','Durable fact one','decision',0.8,'user',$1,$1,$1,0,$1)`,
        [now],
      );
      const fingerprint = memoryStructuralFingerprint({
        content: 'Durable fact one',
        memory_type: 'decision',
        tags: [],
        source: 'user',
        sourceRef: null,
        objective_id: null,
        valid_from: now,
        valid_to: null,
      } as unknown as Memory);
      await pg.query(
        `INSERT INTO memory_evidence_certificates (id,memory_id,project_id,memory_fingerprint,verdict,value_justification,evidence_type,reflector_version,origin,created_at,updated_at) VALUES ('cert-null','mem-ok','project-null',$1,'keep','Durable fact one','code','v1','automatic',$2,$3)`,
        [fingerprint, now, now],
      );
      await pg.query(
        `INSERT INTO memory_audits (id,project_id,initiated_by,runtime_id,prompt_version,status,total_items,processed_items,proposal_items,cursor,retry_count,baseline_fingerprint,created_at,updated_at) VALUES ('ma-null','project-null','u-null','codex:test','v1','ready',1,1,1,1,0,'baseline',$1,$1)`,
        [now],
      );
      // Same persistence mapping as db-memory-audits (`proposedImportance ?? null`).
      await pg.query(
        `INSERT INTO memory_audit_items (id,audit_id,memory_id,memory_fingerprint,processing_state,disposition,proposed_content,proposed_importance,review_decision,revision,created_at,updated_at) VALUES ('mai-null','ma-null','mem-ok',$1,'complete','rewrite',$2,$3,'approved',0,$4,$4)`,
        [
          fingerprint,
          normalized.proposedContent,
          normalized.proposedImportance ?? null,
          now,
        ],
      );
      drizzleDbRef.current = pgliteDrizzle(pg, { schema });

      const view = await applyProjectMemoryAudit('ma-null', 'u-null');
      expect(
        view.items.find((item) => item.id === 'mai-null')?.applied_at,
      ).toBeTruthy();
      expect(await getMemory('mem-ok')).toMatchObject({
        content: 'Durable fact one, clarified',
        importance: 0.8,
      });
    } finally {
      drizzleDbRef.current = previousDb;
      await pg.close();
    }
  });

  test('memory audit reflector accepts null proposed_memory_type without rejecting the batch', () => {
    const normalized = normalizeReflection(
      rewrite({ proposed_memory_type: null }),
      allowed,
    );
    expect(normalized.proposedMemoryType).toBeUndefined();
    expect(normalized.proposedMemoryType).not.toBeNull();
  });

  test('memory audit reflector still rejects proposed_importance outside 0..1', () => {
    expect(() =>
      normalizeReflection(rewrite({ proposed_importance: 1.5 }), allowed),
    ).toThrow('Invalid importance');
    expect(() =>
      normalizeReflection(rewrite({ proposed_importance: -0.1 }), allowed),
    ).toThrow('Invalid importance');
    expect(
      normalizeReflection(rewrite({ proposed_importance: 0 }), allowed)
        .proposedImportance,
    ).toBe(0);
  });
});
