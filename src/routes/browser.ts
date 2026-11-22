import { Router } from 'express';
import { requireAuth } from './auth-helpers.js';
import {
  BrowserViewerLimitError,
  browserViewers,
} from '../lib/browser-viewer.js';
import {
  listBrowserSessions,
  controlBrowser,
} from '../lib/browser-session-access.js';

const router = Router();
router.get(
  '/projects/:projectId/browser/sessions',
  requireAuth,
  async (req: any, res) => {
    const sessions = await listBrowserSessions(
      req.authUser.id,
      req.params.projectId,
      typeof req.query.conversationId === 'string'
        ? req.query.conversationId
        : undefined,
    );
    if (!sessions)
      return res.status(403).json({
        error: 'Project editor access is required to share an agent browser',
      });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sessions });
  },
);
router.post(
  '/projects/:projectId/browser/viewers',
  requireAuth,
  async (req: any, res) => {
    if (typeof req.body?.sessionId !== 'string')
      return res.status(400).json({ error: 'sessionId is required' });
    let viewerId: string | null;
    try {
      viewerId = await browserViewers.issue(
        req.authUser.id,
        req.params.projectId,
        req.body.sessionId,
      );
    } catch (error) {
      if (error instanceof BrowserViewerLimitError)
        return res.status(429).json({ error: error.message });
      throw error;
    }
    if (!viewerId)
      return res.status(404).json({ error: 'Browser session unavailable' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ viewerId });
  },
);
router.post(
  '/projects/:projectId/browser/sessions/:sessionId',
  requireAuth,
  async (req: any, res) => {
    const { action, url } = req.body || {};
    if (
      !['start', 'restart', 'close'].includes(action) ||
      (url !== undefined && typeof url !== 'string')
    )
      return res
        .status(400)
        .json({ error: 'A browser action and optional app URL are required' });
    try {
      await controlBrowser(
        req.authUser.id,
        req.params.projectId,
        req.params.sessionId,
        action,
        url,
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error ? error.message : 'Browser command failed',
      });
    }
  },
);
export default router;
