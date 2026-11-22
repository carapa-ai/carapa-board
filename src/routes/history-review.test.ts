import { describe, expect, mock, test } from 'bun:test';
import express from 'express';
import {
  createHistoryReviewRouter,
  parseHistoryReviewGenerationBody,
  parseHistoryReviewUpdateBody,
} from './history-review.js';
import { requireAdmin } from './_helpers.js';

describe('history review route validation', () => {
  test('requires administrator access', () => {
    const status = mock(() => response);
    const json = mock(() => response);
    const response = { status, json };
    const next = mock(() => undefined);

    requireAdmin({ authUser: { role: 'member' } }, response, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Admin access required' });
    expect(next).not.toHaveBeenCalled();

    status.mockClear();
    json.mockClear();
    requireAdmin({ authUser: { role: 'admin' } }, response, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed proposal-generation requests', () => {
    expect(() =>
      parseHistoryReviewGenerationBody({
        projectId: '',
        since: '2026-09-10T12:00:00Z',
        until: '2026-09-12T12:00:00Z',
      }),
    ).toThrow('projectId');
    expect(() =>
      parseHistoryReviewGenerationBody({
        projectId: 'carapa-board',
        since: 'not-a-date',
        until: '2026-09-12T12:00:00Z',
      }),
    ).toThrow('since');
  });

  test('starts an admin generation request and returns its selectable batch id', async () => {
    const start = mock(async () => ({
      batchId: 'project-history-batch-generated.json',
      completion: Promise.resolve(),
    }));
    const unavailable = async () => {
      throw new Error('unused test dependency');
    };
    const router = createHistoryReviewRouter({
      startHistoryReviewGeneration: start,
      listHistoryReviewBatches: async () => [],
      getHistoryReviewBatch: unavailable,
      getHistoryReviewProject: unavailable,
      updateHistoryReviewItem: unavailable,
      resetHistoryReview: unavailable,
      acceptPartialHistoryReviewBatch: unavailable,
      applyReviewedHistoryProject: unavailable,
    } as unknown as Parameters<typeof createHistoryReviewRouter>[0]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { role: 'admin', username: 'alex' };
      next();
    });
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind to a TCP port');
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/history-reflection/batches`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: 'carapa-board',
            since: '2026-09-10T12:00:00Z',
            until: '2026-09-12T12:00:00Z',
          }),
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        batchId: 'project-history-batch-generated.json',
      });
      expect(start).toHaveBeenCalledWith({
        projectId: 'carapa-board',
        since: '2026-09-10T12:00:00.000Z',
        until: '2026-09-12T12:00:00.000Z',
      });
    } finally {
      server.close();
    }
  });

  test('applies injected memory targets to batch review responses', async () => {
    const unavailable = async () => {
      throw new Error('unused test dependency');
    };
    const attach = mock(async (view: { project_id: string }) => ({
      ...view,
      attached: true,
    }));
    const router = createHistoryReviewRouter({
      startHistoryReviewGeneration: unavailable,
      listHistoryReviewBatches: unavailable,
      getHistoryReviewBatch: async () => ({
        batch: { id: 'batch-1' },
        projects: [{ project_id: 'alpha' }],
      }),
      getHistoryReviewProject: unavailable,
      updateHistoryReviewItem: unavailable,
      resetHistoryReview: unavailable,
      acceptPartialHistoryReviewBatch: unavailable,
      applyReviewedHistoryProject: unavailable,
      attachHistoryReviewTargets: attach,
    } as unknown as Parameters<typeof createHistoryReviewRouter>[0]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { role: 'admin', username: 'alex' };
      next();
    });
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind to a TCP port');
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/history-reflection/batches/batch-1`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        batch: { id: 'batch-1' },
        projects: [{ project_id: 'alpha', attached: true }],
      });
      expect(attach).toHaveBeenCalledWith({ project_id: 'alpha' });
    } finally {
      server.close();
    }
  });

  test("refuses admin access to another user's personal main", async () => {
    const unavailable = async () => {
      throw new Error('unused test dependency');
    };
    const start = mock(async () => ({
      batchId: 'b',
      completion: Promise.resolve(),
    }));
    const apply = mock(unavailable);
    const update = mock(unavailable);
    const router = createHistoryReviewRouter({
      startHistoryReviewGeneration: start,
      listHistoryReviewBatches: async () => [
        { id: 'one', projectId: 'main-other' },
        { id: 'two', projectId: 'ordinary' },
      ],
      getHistoryReviewBatch: unavailable,
      getHistoryReviewProject: async () => ({
        project_id: 'ordinary',
        operations: [{ decision: 'approved', target_project_id: 'main-other' }],
      }),
      updateHistoryReviewItem: update,
      resetHistoryReview: unavailable,
      acceptPartialHistoryReviewBatch: unavailable,
      applyReviewedHistoryProject: apply,
      attachHistoryReviewTargets: unavailable,
      isOwnedByOtherUser: (_userId: string | undefined, projectId: string) =>
        projectId === 'main-other',
    } as unknown as Parameters<typeof createHistoryReviewRouter>[0]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.authUser = { id: 'admin-1', role: 'admin', username: 'alex' };
      next();
    });
    app.use('/api', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server did not bind to a TCP port');
      }
      const base = `http://127.0.0.1:${address.port}/api/history-reflection`;
      const send = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const window = {
        since: '2026-09-10T12:00:00Z',
        until: '2026-09-12T12:00:00Z',
      };
      expect(
        (await send('POST', '/batches', { projectId: 'main-other', ...window }))
          .status,
      ).toBe(403);
      expect(start).not.toHaveBeenCalled();
      expect(
        (await send('POST', '/batches/b/projects/ordinary/apply')).status,
      ).toBe(403);
      expect(apply).not.toHaveBeenCalled();
      expect(
        (
          await send('PUT', '/batches/b/projects/ordinary/review/i', {
            revision: 0,
            decision: 'approved',
            target_project_id: 'main-other',
          })
        ).status,
      ).toBe(403);
      expect(update).not.toHaveBeenCalled();
      const listed = await send('GET', '/batches');
      expect(
        ((await listed.json()) as { batches: { id: string }[] }).batches.map(
          (batch) => batch.id,
        ),
      ).toEqual(['two']);
    } finally {
      server.close();
    }
  });

  test('rejects malformed review requests', () => {
    expect(() =>
      parseHistoryReviewUpdateBody({
        revision: -1,
        decision: 'approved',
      }),
    ).toThrow('revision');
    expect(() =>
      parseHistoryReviewUpdateBody({
        revision: 0,
        decision: 'erase',
      }),
    ).toThrow('decision');
    expect(() =>
      parseHistoryReviewUpdateBody({
        revision: 0,
        decision: 'approved',
        edits: [],
      }),
    ).toThrow('edits');
    expect(() =>
      parseHistoryReviewUpdateBody({
        revision: 0,
        decision: 'approved',
        target_project_id: ' ',
      }),
    ).toThrow('target_project_id');
  });
});
