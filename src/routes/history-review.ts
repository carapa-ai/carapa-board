import { Router } from 'express';
import type { RuntimeSelection } from '../lib/chat-agents.js';
import { startHistoryReviewGeneration } from '../modules/memory/history-review-generation.js';
import {
  HistoryReviewError,
  acceptPartialHistoryReviewBatch,
  applyReviewedHistoryProject,
  attachHistoryReviewTargets,
  getHistoryReviewBatch,
  getHistoryReviewProject,
  listHistoryReviewBatches,
  resetHistoryReview,
  updateHistoryReviewItem,
  type HistoryReviewEdits,
  type HistoryReviewDecision,
  type HistoryReviewProjectView,
} from '../modules/memory/history-review.js';
import { isOwnedByOtherUser } from '../lib/project-ownership.js';
import { requireAdmin } from './_helpers.js';
import { isRecord } from '../lib/type-guards.js';

interface HistoryReviewRouteDeps {
  startHistoryReviewGeneration: typeof startHistoryReviewGeneration;
  listHistoryReviewBatches: typeof listHistoryReviewBatches;
  getHistoryReviewBatch: typeof getHistoryReviewBatch;
  getHistoryReviewProject: typeof getHistoryReviewProject;
  updateHistoryReviewItem: typeof updateHistoryReviewItem;
  resetHistoryReview: typeof resetHistoryReview;
  acceptPartialHistoryReviewBatch: typeof acceptPartialHistoryReviewBatch;
  applyReviewedHistoryProject: typeof applyReviewedHistoryProject;
  attachHistoryReviewTargets: typeof attachHistoryReviewTargets;
  isOwnedByOtherUser?: (
    userId: string | undefined,
    projectId: string,
  ) => boolean;
}

export function parseHistoryReviewGenerationBody(body: unknown): {
  projectId: string;
  since: string;
  until: string;
  reflectorRuntime?: RuntimeSelection;
} {
  if (!isRecord(body)) {
    throw new HistoryReviewError(400, 'Generation body must be an object');
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.projectId !== 'string' ||
    !value.projectId.trim() ||
    value.projectId.length > 200
  ) {
    throw new HistoryReviewError(400, 'projectId must be a project id');
  }
  for (const field of ['since', 'until'] as const) {
    if (
      typeof value[field] !== 'string' ||
      !Number.isFinite(Date.parse(value[field]))
    ) {
      throw new HistoryReviewError(400, `${field} must be an ISO date`);
    }
  }
  if (value.reflectorRuntime !== undefined) {
    const runtime = value.reflectorRuntime;
    if (
      !runtime ||
      typeof runtime !== 'object' ||
      Array.isArray(runtime) ||
      typeof (runtime as Record<string, unknown>).harnessId !== 'string' ||
      typeof (runtime as Record<string, unknown>).modelId !== 'string'
    ) {
      throw new HistoryReviewError(
        400,
        'reflectorRuntime requires harnessId and modelId strings',
      );
    }
  }
  return {
    projectId: value.projectId.trim(),
    since: new Date(value.since as string).toISOString(),
    until: new Date(value.until as string).toISOString(),
    ...(value.reflectorRuntime
      ? { reflectorRuntime: value.reflectorRuntime as RuntimeSelection }
      : {}),
  };
}

export function parseHistoryReviewUpdateBody(body: unknown): {
  revision: number;
  decision: HistoryReviewDecision | 'pending';
  mark_for_eval: boolean;
  target_project_id?: string;
  edits?: HistoryReviewEdits;
} {
  if (!isRecord(body)) {
    throw new HistoryReviewError(400, 'Review body must be an object');
  }
  const value = body as Record<string, unknown>;
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) {
    throw new HistoryReviewError(400, 'revision must be an integer');
  }
  if (
    value.decision !== 'approved' &&
    value.decision !== 'rejected' &&
    value.decision !== 'pending'
  ) {
    throw new HistoryReviewError(400, 'Invalid review decision');
  }
  if (
    value.mark_for_eval !== undefined &&
    typeof value.mark_for_eval !== 'boolean'
  ) {
    throw new HistoryReviewError(400, 'mark_for_eval must be boolean');
  }
  if (
    value.target_project_id !== undefined &&
    (typeof value.target_project_id !== 'string' ||
      !value.target_project_id.trim() ||
      value.target_project_id.length > 200)
  ) {
    throw new HistoryReviewError(400, 'target_project_id must be a project id');
  }
  if (
    value.edits !== undefined &&
    (!value.edits ||
      typeof value.edits !== 'object' ||
      Array.isArray(value.edits))
  ) {
    throw new HistoryReviewError(400, 'edits must be an object');
  }
  return {
    revision: Number(value.revision),
    decision: value.decision,
    mark_for_eval: value.mark_for_eval === true,
    ...(typeof value.target_project_id === 'string'
      ? { target_project_id: value.target_project_id.trim() }
      : {}),
    ...(value.edits ? { edits: value.edits as HistoryReviewEdits } : {}),
  };
}

export function createHistoryReviewRouter(
  deps: HistoryReviewRouteDeps = {
    startHistoryReviewGeneration,
    listHistoryReviewBatches,
    getHistoryReviewBatch,
    getHistoryReviewProject,
    updateHistoryReviewItem,
    resetHistoryReview,
    acceptPartialHistoryReviewBatch,
    applyReviewedHistoryProject,
    attachHistoryReviewTargets,
  },
) {
  const router = Router();

  router.use('/history-reflection', requireAdmin);

  // A project owned by another user is closed to admins.
  const ownedByOther = (req: any, projectId: string | null | undefined) =>
    !!projectId &&
    (deps.isOwnedByOtherUser ?? isOwnedByOtherUser)(
      req.authUser?.id,
      projectId,
    );

  const refuse = (res: any) =>
    res.status(403).json({ error: 'Admin access required' });

  function sendError(res: any, error: unknown): void {
    if (error instanceof HistoryReviewError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async function attachBatchTargets<
    T extends { projects: HistoryReviewProjectView[] },
  >(detail: T): Promise<T> {
    return {
      ...detail,
      projects: await Promise.all(
        detail.projects.map((project) =>
          deps.attachHistoryReviewTargets(project),
        ),
      ),
    };
  }

  router.get('/history-reflection/batches', async (req, res) => {
    try {
      const batches = await deps.listHistoryReviewBatches();
      res.json({
        batches: batches.filter((batch) => !ownedByOther(req, batch.projectId)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/history-reflection/batches', async (req, res) => {
    try {
      const body = parseHistoryReviewGenerationBody(req.body);
      if (ownedByOther(req, body.projectId)) return refuse(res);
      const started = await deps.startHistoryReviewGeneration(body);
      res.status(202).json({ batchId: started.batchId });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/history-reflection/batches/:batchId', async (req, res) => {
    try {
      const batch = await deps.getHistoryReviewBatch(req.params.batchId);
      if (ownedByOther(req, batch.batch.projectId)) return refuse(res);
      res.json(
        await attachBatchTargets({
          ...batch,
          projects: batch.projects.filter(
            (project) => !ownedByOther(req, project.project_id),
          ),
        }),
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(
    '/history-reflection/batches/:batchId/accept-partial',
    async (req, res) => {
      try {
        const batch = await deps.getHistoryReviewBatch(req.params.batchId);
        if (
          ownedByOther(req, batch.batch.projectId) ||
          batch.projects.some((project) =>
            ownedByOther(req, project.project_id),
          )
        ) {
          return refuse(res);
        }
        res.json(
          await attachBatchTargets(
            await deps.acceptPartialHistoryReviewBatch(req.params.batchId),
          ),
        );
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get(
    '/history-reflection/batches/:batchId/projects/:projectId',
    async (req, res) => {
      try {
        if (ownedByOther(req, req.params.projectId)) return refuse(res);
        res.json(
          await deps.attachHistoryReviewTargets(
            await deps.getHistoryReviewProject(
              req.params.batchId,
              req.params.projectId,
            ),
          ),
        );
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.put(
    '/history-reflection/batches/:batchId/projects/:projectId/review/:itemId',
    async (req: any, res) => {
      try {
        const body = parseHistoryReviewUpdateBody(req.body);
        if (
          ownedByOther(req, req.params.projectId) ||
          ownedByOther(req, body.target_project_id)
        ) {
          return refuse(res);
        }
        res.json(
          await deps.attachHistoryReviewTargets(
            await deps.updateHistoryReviewItem(
              req.params.batchId,
              req.params.projectId,
              req.params.itemId,
              {
                revision: Number(body.revision),
                decision: body.decision,
                mark_for_eval: body.mark_for_eval,
                target_project_id: body.target_project_id,
                edits: body.edits,
                reviewer:
                  req.authUser?.username ?? req.authUser?.id ?? 'administrator',
              },
            ),
          ),
        );
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.delete(
    '/history-reflection/batches/:batchId/projects/:projectId/review',
    async (req, res) => {
      try {
        if (ownedByOther(req, req.params.projectId)) return refuse(res);
        res.json(
          await deps.attachHistoryReviewTargets(
            await deps.resetHistoryReview(
              req.params.batchId,
              req.params.projectId,
            ),
          ),
        );
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.post(
    '/history-reflection/batches/:batchId/projects/:projectId/apply',
    async (req, res) => {
      try {
        if (ownedByOther(req, req.params.projectId)) return refuse(res);
        const reviewed = await deps.getHistoryReviewProject(
          req.params.batchId,
          req.params.projectId,
        );
        if (
          reviewed.operations.some(
            (operation) =>
              operation.decision === 'approved' &&
              ownedByOther(req, operation.target_project_id),
          )
        ) {
          return refuse(res);
        }
        const result = await deps.applyReviewedHistoryProject(
          req.params.batchId,
          req.params.projectId,
        );
        res.json({
          ...result,
          project: await deps.attachHistoryReviewTargets(result.project),
        });
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  return router;
}

export default createHistoryReviewRouter();
