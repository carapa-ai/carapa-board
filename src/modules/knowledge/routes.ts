import { Router, type Request, type Response } from 'express';
import { KnowledgeService, KnowledgeFileError } from './knowledge-service.js';
import { knowledgeTagsSchema } from './tags.js';
import { z } from 'zod';
import { isAgentCredential } from '../../routes/_helpers.js';
import { adminBypassesProject } from '../../lib/project-ownership.js';
import * as db from '../../db.js';
import {
  getKbAccessLevel,
  adminBypassesKb,
  getReachableKbIds,
  KB_LEVEL_RANK,
  getProjectAccess,
  upsertKbMember,
  type ProjectAccessLevel,
} from './db-kb.js';
import { logger } from '../../logger.js';
import { PrivacyRefusal } from '../../lib/privacy-policy.js';
import { assertKnowledgeWriteAllowed } from './write-privacy.js';
import { ENABLE_VECTOR_STORE } from '../vector-store/config.js';
import { isVectorStoreAvailable } from '../vector-store/store.js';

/**
 * Project folder an agent (sandbox) credential is confined to, or null for
 * every other caller. Uses the shared `isAgentCredential`.
 * Fails closed to '' (shares nothing) if an agent scope carries no folder.
 */
function agentKbFolder(req: any): string | null {
  if (!isAgentCredential(req)) return null;
  return req.tokenScope?.group_folder ?? '';
}

/**
 * Requires at least `min` access on the KB. The `/knowledge/:id` guard records
 * the caller's level on the request; requests without a recorded level
 * (admins on a KB no user owns) are not level-restricted. Agent tokens
 * are capped at editor on KBs shared with their project.
 */
/** Trimmed KB name, or null when the value is not a string or is blank. */
function trimmedKbName(name: unknown): string | null {
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Trimmed KB description, or null when the value is not a string or is blank. */
function trimmedKbDescription(description: unknown): string | null {
  return typeof description === 'string' && description.trim()
    ? description.trim()
    : null;
}

/** The KBs a signed-in user may see; see `getReachableKbIds`. */
async function visibleKbs<T extends { id: string }>(
  user: { id: string; role?: string },
  kbs: T[],
): Promise<T[]> {
  const reachable = await getReachableKbIds(
    user,
    kbs.map((kb) => kb.id),
  );
  return kbs.filter((kb) => reachable.has(kb.id));
}

function requireKbLevel(min: ProjectAccessLevel) {
  return (req: any, res: any, next: any) => {
    const level: ProjectAccessLevel | undefined = req.kbAccessLevel;
    if (level && KB_LEVEL_RANK[level] < KB_LEVEL_RANK[min]) {
      return res
        .status(403)
        .json({ error: 'Insufficient access level for this knowledge base' });
    }
    next();
  };
}

export function getKnowledgeRouter(): Router {
  const router = Router();

  // All routes are mounted under /api/knowledge

  router.get('/knowledge/status', (_req, res) => {
    const available = isVectorStoreAvailable();
    res.json({
      enabled: ENABLE_VECTOR_STORE,
      available,
      status: !ENABLE_VECTOR_STORE
        ? 'disabled'
        : available
          ? 'available'
          : 'unavailable',
    });
  });

  // Resolve project shares before the :id guard ("shared" is not a KB ID).
  router.get('/knowledge/shared/:group_folder', async (req: any, res) => {
    try {
      const agentFolder = agentKbFolder(req);
      if (agentFolder !== null && req.params.group_folder !== agentFolder) {
        return res
          .status(403)
          .json({ error: 'Access denied to this knowledge base' });
      }
      let kbs = await db.getSharedKnowledgeBases(req.params.group_folder);
      if (req.authUser) kbs = await visibleKbs(req.authUser, kbs);
      res.json(kbs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.use('/knowledge/:id', async (req: any, res: any, next: any) => {
    const agentFolder = agentKbFolder(req);
    if (agentFolder !== null) {
      try {
        const shared = await db.getSharedKnowledgeBases(agentFolder);
        if (!shared.some((kb) => kb.id === req.params.id)) {
          return res
            .status(403)
            .json({ error: 'Access denied to this knowledge base' });
        }
        req.kbAccessLevel = 'editor';
        return next();
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }
    const { id } = req.params;
    if (req.authUser && id && !(await adminBypassesKb(req.authUser, id))) {
      const level = await getKbAccessLevel(req.authUser.id, id);
      if (!level) {
        return res
          .status(403)
          .json({ error: 'Access denied to this knowledge base' });
      }
      req.kbAccessLevel = level;
    }
    next();
  });

  // List all KBs
  router.get('/knowledge', async (req: any, res) => {
    try {
      const agentFolder = agentKbFolder(req);
      if (agentFolder !== null) {
        return res.json(await db.getSharedKnowledgeBases(agentFolder));
      }
      let kbs = await KnowledgeService.getAllKBs();
      if (req.authUser) kbs = await visibleKbs(req.authUser, kbs);
      res.json(kbs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create new KB
  router.post('/knowledge', async (req: any, res) => {
    // A KB created by an agent would have no owner and no MCP equivalent exists.
    if (agentKbFolder(req) !== null) {
      return res
        .status(403)
        .json({ error: 'Agents cannot create knowledge bases' });
    }
    try {
      const { name, description } = req.body;
      const trimmedName = trimmedKbName(name);
      if (!trimmedName) {
        return res.status(400).json({ error: 'Name is required' });
      }
      const kb = await KnowledgeService.createKB(
        trimmedName,
        trimmedKbDescription(description),
      );
      if (req.authUser) {
        await upsertKbMember(req.authUser.id, kb.id, 'owner');
      }
      res.json(kb);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get shares for a KB
  router.get('/knowledge/:id/shares', async (req, res) => {
    try {
      const { id } = req.params;
      const shares = await db.getKnowledgeBaseShares(id);
      res.json(shares);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Share KB with group
  router.post(
    '/knowledge/:id/share',
    requireKbLevel('owner'),
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const { group_folder } = req.body;
        if (!group_folder)
          return res.status(400).json({ error: 'group_folder is required' });
        // Owning the KB is not enough: attaching it to a project exposes it to
        // that project's agent, so the caller must be able to edit the project.
        if (req.authUser && !adminBypassesProject(req.authUser, group_folder)) {
          let allowed = false;
          try {
            const access = await getProjectAccess(
              req.authUser.id,
              group_folder,
            );
            allowed =
              access?.kind === 'explicit' &&
              (access.level === 'owner' || access.level === 'editor');
          } catch (err) {
            logger.warn(
              { err, group_folder },
              'KB share project access lookup failed',
            );
          }
          if (!allowed) {
            return res
              .status(403)
              .json({ error: 'Insufficient access to the target project' });
          }
        }
        await KnowledgeService.shareKB(id, group_folder);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Unshare KB from group
  router.delete(
    '/knowledge/:id/share/:group_folder',
    requireKbLevel('owner'),
    async (req, res) => {
      try {
        const { id, group_folder } = req.params;
        await KnowledgeService.unshareKB(id, group_folder);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // List files in KB
  router.get('/knowledge/:id/files', async (req, res) => {
    try {
      const { id } = req.params;
      const files = await KnowledgeService.listFiles(id);
      res.json(files);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload file to KB (expects JSON with { name, content } where content is base64)
  router.post(
    '/knowledge/:id/files',
    requireKbLevel('editor'),
    async (req, res) => {
      try {
        const { id } = req.params;
        const { name, content, tags } = z
          .object({
            name: z.string().min(1),
            content: z.string().min(1),
            tags: knowledgeTagsSchema.optional(),
          })
          .parse(req.body);
        const agentFolder = agentKbFolder(req);
        if (agentFolder !== null)
          await assertKnowledgeWriteAllowed(id, agentFolder);
        const buffer = Buffer.from(content, 'base64');
        const savedPath = await KnowledgeService.addFile(
          id,
          name,
          buffer,
          tags,
        );
        res.json({ success: true, path: savedPath });
      } catch (err: any) {
        res
          .status(
            err instanceof z.ZodError
              ? 400
              : err instanceof PrivacyRefusal
                ? 403
                : err instanceof KnowledgeFileError
                  ? err.status
                  : 500,
          )
          .json({ error: err.message });
      }
    },
  );

  router.get('/knowledge/:id/tags', async (req, res) => {
    try {
      res.json(await KnowledgeService.listTags(req.params.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/knowledge/:id/search', async (req, res) => {
    try {
      const query = z.string().trim().min(1).parse(req.query.query);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .catch(10)
        .parse(req.query.limit);
      const rawTags = req.query.tags;
      const tags = knowledgeTagsSchema.parse(
        rawTags === undefined
          ? []
          : Array.isArray(rawTags)
            ? rawTags
            : [rawTags],
      );
      const verify =
        z.enum(['true', 'false']).default('false').parse(req.query.verify) ===
        'true';

      res.json(
        await KnowledgeService.searchKnowledgeBase(
          req.params.id,
          query,
          limit,
          tags,
          verify,
        ),
      );
    } catch (err: any) {
      res.status(err instanceof z.ZodError ? 400 : 500).json({
        error: err.message,
      });
    }
  });

  const serveDocumentFile = async (
    req: Request<{ id: string }>,
    res: Response,
    filename: unknown,
    thumbnail: boolean,
  ) => {
    try {
      const name = z.string().min(1).parse(filename);
      const filePath = thumbnail
        ? await KnowledgeService.getThumbnailPath(req.params.id, name)
        : await KnowledgeService.getDocumentPath(req.params.id, name);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache');
      if (!thumbnail) {
        // Raw HTML/SVG documents must never execute on the board origin.
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.attachment(filePath);
      }
      res.sendFile(filePath);
    } catch (err: any) {
      res
        .status(
          err instanceof z.ZodError
            ? 400
            : err instanceof KnowledgeFileError
              ? err.status
              : 500,
        )
        .json({ error: err.message });
    }
  };

  // Query values survive proxy path normalization, keeping nested filenames
  // identical in the client and server signing payloads (including HEAD reads).
  router.get('/knowledge/:id/files/content', async (req, res) => {
    await serveDocumentFile(req, res, req.query.filename, false);
  });
  router.get('/knowledge/:id/files/thumbnail', async (req, res) => {
    await serveDocumentFile(req, res, req.query.filename, true);
  });
  // Preserve existing direct clients; the UI uses the proxy-safe routes above.
  router.get('/knowledge/:id/files/:filename/content', async (req, res) => {
    await serveDocumentFile(req, res, req.params.filename, false);
  });
  router.get('/knowledge/:id/files/:filename/thumbnail', async (req, res) => {
    await serveDocumentFile(req, res, req.params.filename, true);
  });

  const updateDocumentTags = async (req: any, res: any, filename: string) => {
    try {
      const { tags } = z.object({ tags: knowledgeTagsSchema }).parse(req.body);
      const agentFolder = agentKbFolder(req);
      if (agentFolder !== null)
        await assertKnowledgeWriteAllowed(req.params.id, agentFolder);
      const savedTags = await KnowledgeService.updateFileTags(
        req.params.id,
        filename,
        tags,
      );
      res.json({ tags: savedTags });
    } catch (err: any) {
      res
        .status(
          err instanceof z.ZodError
            ? 400
            : err instanceof PrivacyRefusal
              ? 403
              : err instanceof KnowledgeFileError
                ? err.status
                : 500,
        )
        .json({ error: err.message });
    }
  };

  // Keep the filename in the signed body instead of the URL path. This avoids
  // encoded slashes in nested document paths being decoded by a reverse proxy
  // before the request signature is verified.
  router.patch(
    '/knowledge/:id/files/metadata',
    requireKbLevel('editor'),
    async (req, res) => {
      try {
        const { filename } = z
          .object({ filename: z.string().min(1) })
          .parse(req.body);
        await updateDocumentTags(req, res, filename);
      } catch (err: any) {
        res
          .status(err instanceof z.ZodError ? 400 : 500)
          .json({ error: err.message });
      }
    },
  );

  router.patch(
    '/knowledge/:id/files/:filename/metadata',
    requireKbLevel('editor'),
    async (req, res) => {
      await updateDocumentTags(req, res, req.params.filename);
    },
  );

  // Save a chat message as an enriched note (auto filename + summary + transcript + fetched web sources)
  router.post(
    '/knowledge/:id/save-message',
    requireKbLevel('editor'),
    async (req: any, res) => {
      try {
        const { id } = req.params;
        const { content, group_folder } = req.body;
        if (!content)
          return res.status(400).json({ error: 'content is required' });

        const agentFolder = agentKbFolder(req);
        if (agentFolder !== null)
          await assertKnowledgeWriteAllowed(id, agentFolder);
        let projectFolder = agentFolder ?? group_folder;
        if (
          agentFolder === null &&
          req.authUser &&
          (typeof projectFolder !== 'string' ||
            (!adminBypassesProject(req.authUser, projectFolder) &&
              !(await getProjectAccess(req.authUser.id, projectFolder))))
        ) {
          projectFolder = undefined;
        }
        const path = await KnowledgeService.saveEnrichedNote(
          id,
          content,
          projectFolder,
        );
        res.json({ success: true, path });
      } catch (err: any) {
        res
          .status(err instanceof PrivacyRefusal ? 403 : 500)
          .json({ error: err.message });
      }
    },
  );

  const deleteDocument = async (req: any, res: any, filename: unknown) => {
    try {
      const name = z.string().min(1).parse(filename);
      await KnowledgeService.deleteFile(req.params.id, name);
      res.json({ success: true });
    } catch (err: any) {
      res
        .status(
          err instanceof z.ZodError
            ? 400
            : err instanceof KnowledgeFileError
              ? err.status
              : 500,
        )
        .json({ error: err.message });
    }
  };

  // Delete file from KB. The filename travels in the query string so nested
  // paths survive proxies that decode encoded slashes in the URL path.
  router.delete(
    '/knowledge/:id/files',
    requireKbLevel('editor'),
    async (req, res) => {
      await deleteDocument(req, res, req.query.filename);
    },
  );

  // Preserve existing direct clients; the UI uses the proxy-safe route above.
  router.delete(
    '/knowledge/:id/files/:filename',
    requireKbLevel('editor'),
    async (req, res) => {
      await deleteDocument(req, res, req.params.filename);
    },
  );

  // Trigger Indexing
  router.post(
    '/knowledge/:id/index',
    requireKbLevel('editor'),
    async (req, res) => {
      try {
        const { id } = req.params;
        // Run indexing in background
        KnowledgeService.indexKB(id).catch((err) => {
          logger.error({ err, kb_id: id }, 'Background indexing failed');
        });
        res.json({ status: 'indexing_started' });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // Delete KB
  router.delete('/knowledge/:id', requireKbLevel('owner'), async (req, res) => {
    try {
      const { id } = req.params;
      await KnowledgeService.deleteKB(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update KB
  router.patch('/knowledge/:id', requireKbLevel('owner'), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;
      const updates: { name?: string; description?: string | null } = {};
      if (name !== undefined) {
        const trimmedName = trimmedKbName(name);
        if (!trimmedName) {
          return res.status(400).json({ error: 'Name is required' });
        }
        updates.name = trimmedName;
      }
      if (description !== undefined) {
        updates.description = trimmedKbDescription(description);
      }
      const kb = await KnowledgeService.updateKB(id, updates);
      res.json(kb);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
