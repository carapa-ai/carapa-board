import { Router } from 'express';
import {
  approveAndApplyProjectMemoryAudit,
  applyProjectMemoryAudit,
  deleteSkippedAuditMemory,
  forceRecheckMemory,
  getProjectMemoryAudit,
  getProjectMemoryAuditReport,
  getProjectMemoryAudits,
  MemoryAuditError,
  resumeProjectMemoryAudit,
  reviewMemoryAuditItem,
  startProjectMemoryAudit,
  startProjectMemoryIndex,
  startProjectMemoryReorganization,
} from '../modules/memory/memory-audit.js';
import { relatedMemoryProjects } from '../modules/memory/memory-reorganize.js';
import { registeredGroups } from '../state-manager.js';
import { isOwnedByOtherUser } from '../lib/project-ownership.js';
import { denyUnlessAdmin } from './_helpers.js';
import { isRecord } from '../lib/type-guards.js';

export function requireMemoryAuditAdmin(req: any, res: any, next: any) {
  if (!denyUnlessAdmin(req, res)) return;
  const projectId = req.params?.projectId;
  if (
    typeof projectId === 'string' &&
    [
      projectId,
      ...relatedMemoryProjects(projectId, registeredGroups).map((r) => r.id),
    ].some((id) => isOwnedByOtherUser(req.authUser.id, id))
  ) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function sendError(res: any, error: unknown): void {
  if (error instanceof MemoryAuditError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res
    .status(500)
    .json({ error: error instanceof Error ? error.message : String(error) });
}

export function parseMemoryAuditReviewBody(body: any) {
  if (!body || !Number.isInteger(body.revision) || body.revision < 0) {
    throw new MemoryAuditError(400, 'revision must be a non-negative integer');
  }
  if (
    ![
      'pending',
      'approved',
      'rejected',
      'delete_memory',
      'delete_both',
      'dismissed',
    ].includes(body.decision)
  ) {
    throw new MemoryAuditError(400, 'Invalid review decision');
  }
  const edits = body.edits;
  if (edits !== undefined && !isRecord(edits)) {
    throw new MemoryAuditError(400, 'edits must be an object');
  }
  if (
    edits?.proposed_content !== undefined &&
    (typeof edits.proposed_content !== 'string' ||
      !edits.proposed_content.trim() ||
      edits.proposed_content.length > 20_000)
  ) {
    throw new MemoryAuditError(
      400,
      'proposed_content must be 1..20000 characters',
    );
  }
  if (
    edits?.reason !== undefined &&
    (typeof edits.reason !== 'string' || edits.reason.length > 4000)
  ) {
    throw new MemoryAuditError(400, 'reason must be at most 4000 characters');
  }
  if (
    edits?.proposed_importance !== undefined &&
    (typeof edits.proposed_importance !== 'number' ||
      edits.proposed_importance < 0 ||
      edits.proposed_importance > 1)
  ) {
    throw new MemoryAuditError(
      400,
      'proposed_importance must be between 0 and 1',
    );
  }
  if (
    edits?.proposed_memory_type !== undefined &&
    ![
      'identity',
      'project',
      'goal',
      'decision',
      'preference',
      'contact',
      'event',
      'task',
    ].includes(edits.proposed_memory_type)
  ) {
    throw new MemoryAuditError(400, 'Invalid proposed_memory_type');
  }
  if (
    edits?.proposed_tags !== undefined &&
    (!Array.isArray(edits.proposed_tags) ||
      edits.proposed_tags.length > 30 ||
      edits.proposed_tags.some((tag: unknown) => typeof tag !== 'string'))
  ) {
    throw new MemoryAuditError(
      400,
      'proposed_tags must be an array of at most 30 strings',
    );
  }
  if (
    edits?.proposed_valid_from !== undefined &&
    (typeof edits.proposed_valid_from !== 'string' ||
      !Number.isFinite(Date.parse(edits.proposed_valid_from)) ||
      Date.parse(edits.proposed_valid_from) > Date.now() + 300_000)
  ) {
    throw new MemoryAuditError(
      400,
      'proposed_valid_from must be an ISO timestamp',
    );
  }
  if (
    edits?.target_project_id !== undefined &&
    (typeof edits.target_project_id !== 'string' ||
      !edits.target_project_id.trim() ||
      edits.target_project_id.length > 200)
  ) {
    throw new MemoryAuditError(400, 'target_project_id must be a project ID');
  }
  return { revision: body.revision, decision: body.decision, edits };
}

const router = Router();
router.use(
  '/memory-review/projects/:projectId/audits',
  requireMemoryAuditAdmin,
);

router.get('/memory-review/projects/:projectId/audits', async (req, res) => {
  try {
    res.json({ audits: await getProjectMemoryAudits(req.params.projectId) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get(
  '/memory-review/projects/:projectId/audits/report',
  async (req, res) => {
    try {
      res.json(await getProjectMemoryAuditReport(req.params.projectId));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/memory-review/projects/:projectId/audits',
  async (req: any, res) => {
    try {
      const mode = req.body?.mode ?? 'cleanup';
      if (!['cleanup', 'index', 'reorganize'].includes(mode)) {
        throw new MemoryAuditError(
          400,
          'mode must be cleanup, index, or reorganize',
        );
      }
      const result =
        mode === 'index'
          ? await startProjectMemoryIndex(req.params.projectId, req.authUser.id)
          : mode === 'reorganize'
            ? await startProjectMemoryReorganization(
                req.params.projectId,
                req.authUser.id,
              )
            : await startProjectMemoryAudit(
                req.params.projectId,
                req.authUser.id,
              );
      res.status(result.created ? 202 : 200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  '/memory-review/projects/:projectId/audits/:auditId',
  async (req, res) => {
    try {
      res.json(
        await getProjectMemoryAudit(req.params.auditId, req.params.projectId),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/memory-review/projects/:projectId/audits/:auditId/resume',
  async (req, res) => {
    try {
      const audit = await getProjectMemoryAudit(
        req.params.auditId,
        req.params.projectId,
      );
      res.status(202).json(await resumeProjectMemoryAudit(audit.id));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.put(
  '/memory-review/projects/:projectId/audits/:auditId/items/:itemId',
  async (req: any, res) => {
    try {
      await getProjectMemoryAudit(req.params.auditId, req.params.projectId);
      const body = parseMemoryAuditReviewBody(req.body);
      res.json(
        await reviewMemoryAuditItem({
          auditId: req.params.auditId,
          itemId: req.params.itemId,
          revision: body.revision,
          decision: body.decision,
          reviewer: req.authUser.username ?? req.authUser.id,
          edits: body.edits,
        }),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.delete(
  '/memory-review/projects/:projectId/audits/:auditId/items/:itemId/skipped-memory',
  async (req: any, res) => {
    try {
      res.json(
        await deleteSkippedAuditMemory({
          auditId: req.params.auditId,
          projectId: req.params.projectId,
          itemId: req.params.itemId,
          reviewer: req.authUser.username ?? req.authUser.id,
        }),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/memory-review/projects/:projectId/audits/:auditId/items/:memoryId/recheck',
  async (req, res) => {
    try {
      await getProjectMemoryAudit(req.params.auditId, req.params.projectId);
      await forceRecheckMemory(req.params.auditId, req.params.memoryId);
      res.status(202).json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/memory-review/projects/:projectId/audits/:auditId/approve-all-and-apply',
  async (req: any, res) => {
    try {
      await getProjectMemoryAudit(req.params.auditId, req.params.projectId);
      res.json(
        await approveAndApplyProjectMemoryAudit(
          req.params.auditId,
          req.authUser.username ?? req.authUser.id,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/memory-review/projects/:projectId/audits/:auditId/apply',
  async (req: any, res) => {
    try {
      await getProjectMemoryAudit(req.params.auditId, req.params.projectId);
      res.json(
        await applyProjectMemoryAudit(
          req.params.auditId,
          req.authUser.username ?? req.authUser.id,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;
