import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { initDatabase } from '../db.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import {
  parseMemoryAuditReviewBody,
  requireMemoryAuditAdmin,
} from './memory-audits.js';

describe('memory audit route validation', () => {
  test('requires administrator access', () => {
    const response: any = {};
    response.status = mock(() => response);
    response.json = mock(() => response);
    const next = mock(() => undefined);
    requireMemoryAuditAdmin({ authUser: { role: 'user' } }, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    response.status.mockClear();
    requireMemoryAuditAdmin({ authUser: { role: 'admin' } }, response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('personal mains', () => {
    const folders = ['audit-foreign-main', 'audit-child', 'audit-ordinary'];
    beforeAll(async () => {
      await initDatabase(':memory:');
      await loadState();
      const now = new Date().toISOString();
      for (const folder of folders) {
        await registerGroup(`${folder}@kanban`, {
          name: folder,
          folder,
          jid: `${folder}@kanban`,
          trigger: '!',
          added_at: now,
          ...(folder === 'audit-foreign-main'
            ? { is_main: true, user_id: 'someone-else' }
            : {}),
          ...(folder === 'audit-child'
            ? { parentId: 'audit-foreign-main' }
            : {}),
        });
      }
    });
    afterAll(async () => {
      for (const folder of folders) await unregisterGroup(`${folder}@kanban`);
    });

    test("refuses admins on another user's main and projects related to it", () => {
      const run = (projectId: string) => {
        const response: any = {};
        response.status = mock(() => response);
        response.json = mock(() => response);
        const next = mock(() => undefined);
        requireMemoryAuditAdmin(
          { authUser: { id: 'admin-1', role: 'admin' }, params: { projectId } },
          response,
          next,
        );
        return { response, next };
      };
      for (const id of ['audit-foreign-main', 'audit-child']) {
        const { response, next } = run(id);
        expect(response.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      }
      expect(run('audit-ordinary').next).toHaveBeenCalledTimes(1);
    });
  });

  test('validates optimistic review bodies and editable fields', () => {
    expect(
      parseMemoryAuditReviewBody({
        revision: 2,
        decision: 'approved',
        edits: { proposed_content: 'Canonical fact', proposed_importance: 0.8 },
      }),
    ).toEqual({
      revision: 2,
      decision: 'approved',
      edits: { proposed_content: 'Canonical fact', proposed_importance: 0.8 },
    });
    expect(() =>
      parseMemoryAuditReviewBody({ revision: -1, decision: 'approved' }),
    ).toThrow('revision');
    expect(() =>
      parseMemoryAuditReviewBody({ revision: 0, decision: 'erase' }),
    ).toThrow('decision');
    expect(
      parseMemoryAuditReviewBody({ revision: 0, decision: 'delete_both' }),
    ).toMatchObject({ decision: 'delete_both' });
    expect(
      parseMemoryAuditReviewBody({ revision: 0, decision: 'delete_memory' }),
    ).toMatchObject({ decision: 'delete_memory' });
    expect(
      parseMemoryAuditReviewBody({ revision: 0, decision: 'dismissed' }),
    ).toMatchObject({ decision: 'dismissed' });
    expect(() =>
      parseMemoryAuditReviewBody({
        revision: 0,
        decision: 'approved',
        edits: { proposed_importance: 2 },
      }),
    ).toThrow('importance');
    expect(() =>
      parseMemoryAuditReviewBody({
        revision: 0,
        decision: 'approved',
        edits: { proposed_valid_from: 'not-a-date' },
      }),
    ).toThrow('proposed_valid_from');
    expect(
      parseMemoryAuditReviewBody({
        revision: 3,
        decision: 'approved',
        edits: { target_project_id: 'related-project' },
      }),
    ).toEqual({
      revision: 3,
      decision: 'approved',
      edits: { target_project_id: 'related-project' },
    });
    expect(() =>
      parseMemoryAuditReviewBody({
        revision: 3,
        decision: 'approved',
        edits: { target_project_id: '' },
      }),
    ).toThrow('target_project_id');
  });
});
